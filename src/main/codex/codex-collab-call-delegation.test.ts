// A running chat holds a subagent's section open while the parent's newest row delegates to it.
// In Codex's default multi-agent mode that row is the collab call the host writes as a tool row,
// so the rows the real adapter publishes must read as a delegation to the helper they name.

import { describe, expect, it } from 'vitest'
import { codexCollabRowAgentIds } from '../../shared/codex-collab-agent-tools'
import { projectNativeChatTranscript } from '../../shared/native-chat-transcript-projection'
import type { NativeChatMessage } from '../../shared/native-chat-types'
import { projectStructuredAgentSessionMessages } from '../../shared/structured-agent-session-message-projection'
import {
  nativeChatSubagentDelegation,
  type NativeChatSubagentDelegation
} from '../../renderer/src/components/native-chat/native-chat-subagent-delegation'
import {
  collab,
  HELPER,
  HELPER_TURN,
  PARENT_TURN,
  publishedRows,
  shell,
  spawn,
  turn,
  waitStarted,
  type Frame
} from './codex-collab-call-frames-fixture'
import { THREAD_ID } from './codex-structured-session-adapter-fixture'

/** The delegation the parent's newest tool run reads as, the row a running chat's frontier judges. */
async function newestRunDelegation(frames: Frame[]): Promise<NativeChatSubagentDelegation | null> {
  const { conversation } = projectNativeChatTranscript(
    projectStructuredAgentSessionMessages(await publishedRows(frames), [], [])
  )
  const runs = conversation.filter((message: NativeChatMessage) =>
    message.blocks.some((block) => block.type === 'tool-call')
  )
  const newest = runs.at(-1)
  return newest ? nativeChatSubagentDelegation(newest) : null
}

const spawned = [
  turn('turn/started', THREAD_ID, PARENT_TURN),
  spawn('item/started'),
  spawn('item/completed'),
  turn('turn/started', HELPER, HELPER_TURN),
  shell('item/started', HELPER, HELPER_TURN, 'call-helper-shell', 'CHILD_DONE')
]

describe("a Codex default-mode collab call row as the parent's delegation", () => {
  it('delegates to the helper a finished spawn names', async () => {
    expect(await newestRunDelegation(spawned)).toEqual({ kind: 'call', agentId: HELPER })
  })

  it('delegates to the helper a running wait names', async () => {
    expect(await newestRunDelegation([...spawned, waitStarted])).toEqual({
      kind: 'call',
      agentId: HELPER
    })
  })

  it('delegates to the helper a close names, as a raw collab row did', async () => {
    const close = collab('item/started', {
      id: 'call-close',
      tool: 'closeAgent',
      status: 'inProgress',
      receiverThreadIds: [HELPER]
    })
    expect(await newestRunDelegation([...spawned, close])).toEqual({
      kind: 'call',
      agentId: HELPER
    })
  })

  it('reads a spawn still starting, which names no helper, as ordinary output', async () => {
    expect(
      await newestRunDelegation([
        turn('turn/started', THREAD_ID, PARENT_TURN),
        spawn('item/started')
      ])
    ).toBeNull()
  })

  it("reads the parent's next call as superseding the delegation", async () => {
    expect(
      await newestRunDelegation([
        ...spawned,
        shell('item/started', THREAD_ID, PARENT_TURN, 'call-parent-shell', 'PARENT_DONE')
      ])
    ).toBeNull()
  })

  it('keeps naming the helper when its prompt is past the journal limit', async () => {
    const prompt = `Review lane a. ${'x'.repeat(20_000)}`
    const longSpawn = [
      turn('turn/started', THREAD_ID, PARENT_TURN),
      collab('item/completed', {
        id: 'call-spawn',
        tool: 'spawnAgent',
        status: 'completed',
        receiverThreadIds: [HELPER],
        prompt
      })
    ]
    const row = (await publishedRows(longSpawn))
      .map(({ body }) => body)
      .find((body) => body.kind === 'tool-call' && body.name === 'spawn_agent')
    const input = row?.kind === 'tool-call' ? row.input : undefined
    expect(input).toMatchObject({
      description: expect.stringMatching(/^Review lane a\. x+…$/),
      prompt: expect.stringContaining('[Orca: output truncated')
    })
    expect(codexCollabRowAgentIds(input)).toEqual([HELPER])
    expect(await newestRunDelegation(longSpawn)).toEqual({ kind: 'call', agentId: HELPER })
  })
})
