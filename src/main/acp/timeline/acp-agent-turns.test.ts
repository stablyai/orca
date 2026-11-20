import { afterEach, describe, expect, it } from 'vitest'
import { closeProviderTimelineRigs } from '../../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { isBackgroundTaskBlock } from '../../../shared/native-chat/native-chat-types'
import { ANTIGRAVITY_ACP_DIALECT } from '../acp-dialects/antigravity-dialect'
import { openAcpFixtureRig, readAcpFixture } from './testing/acp-timeline-fixture.test-support'

afterEach(closeProviderTimelineRigs)

describe('Antigravity reactive wakeups', () => {
  // Recorded from agy 1.5.12: `sleep 20` backgrounds past WaitMsBeforeAsync, the prompt ends,
  // then the agent reports the command's output with no prompt open (#40447).
  it('journals the unprompted report in its own turn and settles the backgrounded call', async () => {
    const fixture = await openAcpFixtureRig(ANTIGRAVITY_ACP_DIALECT)
    await fixture.feed(await readAcpFixture('antigravity-v1.5.12-reactive-wakeup'))
    fixture.apply(fixture.lane().endAgentTurn(5_000))

    const rows = await fixture.rig.rows()
    const replies = rows.flatMap((row) =>
      row.body.kind === 'message' && row.body.role === 'assistant'
        ? row.body.blocks.flatMap((block) =>
            block.type === 'text'
              ? [{ text: block.text.trim(), scope: row.turnScope ?? { kind: 'thread' } }]
              : []
          )
        : []
    )
    expect(replies.map((reply) => reply.text)).toEqual(['started', '`MARKER_orwa8q`'])
    const [prompt, wakeup] = replies.map((reply) => reply.scope)
    expect(wakeup).toMatchObject({ kind: 'turn' })
    expect(wakeup).not.toEqual(prompt)
    expect(rows.find((row) => row.body.kind === 'tool-call')?.body).toMatchObject({
      state: 'completed'
    })
    const task = rows
      .flatMap((row) => (row.body.kind === 'message' ? row.body.blocks : []))
      .find(isBackgroundTaskBlock)
    expect(task).toMatchObject({
      kind: 'command',
      label: 'sleep 20; echo MARKER_orwa8q',
      state: 'done',
      summary: expect.stringContaining('MARKER_orwa8q')
    })
    expect((await fixture.rig.turns()).map((turn) => turn.state)).toEqual([
      'completed',
      'completed'
    ])
  })
})
