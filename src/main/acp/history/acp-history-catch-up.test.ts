// A reopened chat catches up on turns its agent replays that the chat never saw, against real
// OpenCode 2.0.14 and Grok 1.0.62 recordings: once, in order, without a notice, and never a turn
// the chat already holds.

import {
  setup,
  dividers,
  chatSend,
  replayUpdate,
  userReplay,
  answerReplay
} from './acp-history-catch-up.test-support'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import '../../../shared/agent-session/failures/agent-session-failure'
import '../../../shared/agent-session/failures/agent-session-failure-words'
import {
  closeProviderTimelineRigs,
  AGENT,
  NAMESPACE
} from '../../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { GROK_ACP_DIALECT } from '../acp-dialects/grok-dialect'
import { OPENCODE_ACP_DIALECT } from '../acp-dialects/opencode-dialect'
import '../../../shared/agent-session/lifecycle/agent-session-turn-record'
import '../acp-turn-messages'
import '../../native-chat/agent-session-timeline/provider-timeline-history'
import '../../native-chat/agent-session-wire/observations/structured-agent-session-current-work'
import '../../native-chat/agent-session-wire/termination/structured-agent-session-unfinished-work'
import '../../native-chat/agent-session-wire/termination/structured-agent-session-dead-generation-settlement'
import './acp-history-replay'
import { asReattachHistory } from '../acp-structured-session'
import { readAcpFixture, type AcpFixtureFrame } from '../acp-timeline-fixture.test-support'

afterEach(async () => {
  vi.restoreAllMocks()
  await closeProviderTimelineRigs()
})

async function recording(name: string): Promise<AcpFixtureFrame[]> {
  // The rig's journal keys rows under its own provider session.
  return JSON.parse(
    JSON.stringify(await readAcpFixture(name)).replaceAll('"session-1"', JSON.stringify(NAMESPACE))
  )
}

/** What the chat's lane kept while process `process` replayed its history on load. */
function loadReplay(frames: AcpFixtureFrame[], process: string) {
  const own = frames.filter((frame) => frame.process === process)
  const load = own.findIndex((frame) => frame.message.method === 'session/load')
  const answered = own.findIndex((frame, index) => index > load && frame.message.id !== undefined)
  return own.slice(load + 1, answered).map((frame) => ({
    method: frame.message.method!,
    params: asReattachHistory(frame.message.params)
  }))
}

function userTexts(rows: AgentJournalRenderItem[]): string[] {
  return rows.flatMap((row) =>
    row.body.kind === 'message' && row.body.role === 'user' && row.body.blocks[0]?.type === 'text'
      ? [row.body.blocks[0].text]
      : []
  )
}

describe('ACP history catch-up', () => {
  it('adds an OpenCode turn made outside the chat once, completing it on a later open', async () => {
    const { fixture, catchUp } = await setup(OPENCODE_ACP_DIALECT, 'user-message-id')
    const frames = await recording('opencode-v2-reopen')
    const chat = frames.filter((frame) => frame.process === 'A')
    const prompts = chat.filter((frame) => frame.message.method === 'session/prompt')
    // The chat saw its first two turns; the third ran outside it.
    await fixture.feed(chat.slice(0, chat.indexOf(prompts[2]!)))
    const before = await fixture.rig.rows()
    await fixture.restart()
    const replay = loadReplay(frames, 'B')
    const outsideTool = replay.findLastIndex((frame) =>
      JSON.stringify(frame.params).includes('"tool_call"')
    )

    // Opened while the outside turn had only begun: it shows as far as it went.
    await catchUp(replay.slice(0, outsideTool))
    const partial = await fixture.rig.rows()
    expect(partial.slice(0, before.length).map((row) => row.itemId)).toEqual(
      before.map((row) => row.itemId)
    )
    const added = partial.slice(before.length)
    expect(dividers(partial)).toHaveLength(0)
    expect(userTexts(added)).toEqual([expect.stringContaining('sleep 40')])

    await catchUp(replay)
    const complete = await fixture.rig.rows()
    expect(dividers(complete)).toHaveLength(0)
    expect(userTexts(complete)).toEqual([expect.stringContaining('sleep 40')])
    expect(complete.filter((row) => row.body.kind === 'tool-call')).toHaveLength(3)

    await catchUp(replay)
    expect(await fixture.rig.rows()).toEqual(complete)
  })

  it('adds a Grok turn made outside the chat under its own id, never the turn Orca sent', async () => {
    const { fixture, catchUp } = await setup(GROK_ACP_DIALECT, 'prompt-id')
    const frames = await recording('grok-v1-reopen-outside')
    await fixture.feed(frames.filter((frame) => frame.process === 'A'))
    await chatSend(fixture, 'A:3', 'Reply with exactly the word ONE.')
    await fixture.restart()

    await catchUp(loadReplay(frames, 'C'))
    const rows = await fixture.rig.rows()
    expect(userTexts(rows)).toEqual([
      'Reply with exactly the word ONE.',
      expect.stringContaining('TWO-TOOL')
    ])
    expect(dividers(rows)).toHaveLength(0)
    expect((await fixture.rig.turns()).map((turn) => turn.state)).toEqual([
      'completed',
      'completed'
    ])
  })
})

it('skips the copied root after undo and imports each new root once without timestamps', async () => {
  const { fixture, catchUp } = await setup(OPENCODE_ACP_DIALECT, 'user-message-id')
  const journal = fixture.rig.journal
  await journal.replaceEpochItems(
    'session_created',
    1,
    [
      {
        identity: { provider: 'legacy', agent: AGENT, sessionId: 'source', recordId: 'rich' },
        ownerFence: 0,
        observedAt: 123,
        body: {
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'rich copied history' }]
        }
      }
    ],
    undefined,
    undefined,
    {
      version: 1,
      kind: 'native_copy',
      agent: AGENT,
      unit: 'acp-user-message',
      providerHandle: { kind: 'opaque', agent: AGENT, value: NAMESPACE },
      ids: ['U1', 'U2']
    }
  )
  const frames = [
    replayUpdate('user_message_chunk', {
      messageId: 'U1',
      content: { type: 'resource_link', uri: 'file:///image.png', name: 'image' }
    }),
    answerReplay('provider copy of inherited reply', 'A1'),
    userReplay('U3', 'new after undo'),
    answerReplay('new reply', 'A3')
  ]
  await catchUp(frames)
  await catchUp(frames)
  const next = [
    ...frames,
    userReplay('U4', 'local later'),
    answerReplay('four', 'A4'),
    userReplay('U5', 'CLI later'),
    answerReplay('five', 'A5')
  ]
  await catchUp(next)
  await catchUp(next)
  expect(
    journal
      .snapshot()
      .items.flatMap((item) =>
        item.body.kind === 'message' && item.body.role === 'assistant'
          ? item.body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : []))
          : []
      )
  ).toEqual(['rich copied history', 'new reply', 'four', 'five'])
})
