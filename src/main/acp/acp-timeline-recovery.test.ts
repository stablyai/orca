import { afterEach, describe, expect, it } from 'vitest'
import { contextTokensFromUsage } from '../../shared/agent-session/agent-session-context-usage'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { openAcpFixtureRig, readAcpFixture } from './acp-timeline-fixture.test-support'
import { AcpTimelineTranslator } from './acp-timeline-translator'
import { GROK_ACP_DIALECT } from './acp-dialects/grok-dialect'

afterEach(closeProviderTimelineRigs)

describe('ACP reviewed traffic and recovery', () => {
  it('replays every notification in the full recording without extension status rows or persisted signatures', async () => {
    const f = await openAcpFixtureRig()
    const frames = await readAcpFixture('s1-full-notifications')
    const rows = await f.feed(frames)
    expect(rows.filter((row) => row.body.kind === 'status')).toEqual([])
    expect(rows.filter((row) => row.body.kind === 'tool-call')).toHaveLength(2)
    expect(rows.filter((row) => row.body.kind === 'message')).toHaveLength(2)
    expect(await f.rig.turns()).toHaveLength(1)
    expect(JSON.stringify(rows)).not.toContain('signature')
    const context = (await f.rig.turns())[0]?.contextUsage
    expect(context?.window?.tokens).toBe(256000)
    expect(context?.used?.kind === 'estimate' && contextTokensFromUsage(context.used.usage)).toBe(
      34622
    )
  })

  it('uses the last of nine model calls instead of the aggregate turn usage', async () => {
    const f = await openAcpFixtureRig()
    await f.feed(await readAcpFixture('s5-plan-approved'))
    const usage = (await f.rig.turns())[0]?.contextUsage?.used
    expect(usage?.kind === 'estimate' && contextTokensFromUsage(usage.usage)).toBe(39190)
  })

  it.each([undefined, null])(
    'accepts an empty plan request: placeholder plan row, answered at once without approving (%s)',
    async (planContent) => {
      const f = await openAcpFixtureRig()
      for (const method of ['_x.ai/exit_plan_mode', 'x.ai/exit_plan_mode']) {
        const translated = f
          .lane()
          .request(method, { sessionId: 'session-1', toolCallId: 'plan', planContent }, 1)
        expect(translated.presentation).toBeUndefined()
        expect(translated.events).toMatchObject([
          {
            type: 'item.update',
            body: {
              kind: 'status',
              presentation: 'plan-document',
              text: 'The agent exited plan mode without writing a plan.'
            }
          }
        ])
        expect(translated.settled?.reply).toMatchObject({ outcome: 'abandoned' })
      }
    }
  )

  it('retains full late tool updates through more than 128 concurrent tools', () => {
    const lane = new AcpTimelineTranslator({ sessionId: 'session-1', dialect: GROK_ACP_DIALECT })
    const big = 'x"\\'.repeat(12000)
    for (let index = 0; index < 160; index += 1) {
      expect(() =>
        lane.notification(
          'session/update',
          {
            sessionId: 'session-1',
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: `t${index}`,
              title: 'Write',
              status: 'in_progress',
              rawInput: { content: big },
              rawOutput: big
            }
          },
          index
        )
      ).not.toThrow()
    }
    for (let index = 0; index < 160; index += 1) {
      expect(
        lane.notification(
          'session/update',
          {
            sessionId: 'session-1',
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: `t${index}`,
              status: 'completed'
            }
          },
          50 + index
        )
      ).toMatchObject([
        {
          type: 'item.close',
          body: {
            state: 'completed',
            name: 'Write',
            input: { content: big },
            output: { head: big, truncated: false }
          }
        }
      ])
    }
  })

  it('keeps the first message on its original turn after more than 128 newer IDs', async () => {
    const f = await openAcpFixtureRig()
    const lane = f.lane()
    f.apply(lane.openPrompt('send-1', 1_000).events)
    for (let index = 0; index < 160; index += 1) {
      f.apply(
        lane.notification(
          'session/update',
          {
            sessionId: 'session-1',
            update: {
              sessionUpdate: 'agent_message_chunk',
              messageId: `m${index}`,
              content: { type: 'text', text: 'Original text' }
            }
          },
          1_001 + index
        )
      )
    }
    f.apply(lane.promptResult('send-1', { stopReason: 'end_turn' }, 2_000))
    f.apply(lane.openPrompt('send-2', 3_000).events)
    const before = await f.rig.rows()
    f.apply(
      lane.notification(
        'session/update',
        {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'm0',
            content: { type: 'text', text: 'Must not move turns' }
          }
        },
        3_001
      )
    )
    f.rig.assembler.flush()
    expect(await f.rig.rows()).toEqual(before)
  })

  it('ignores stray replay and both extension method aliases by default', async () => {
    const f = await openAcpFixtureRig()
    for (const method of ['_x.ai/session_notification', 'x.ai/session_notification']) {
      expect(
        f.lane().notification(
          method,
          {
            sessionId: 'session-1',
            update: { sessionUpdate: 'response_completed', signature: 'opaque' }
          },
          1000
        )
      ).toEqual([])
    }
    expect(f.lane().notification('_unknown/extension', { sessionId: 'session-1' }, 1000)).toEqual(
      []
    )
    expect(
      f.lane().notification(
        'session/update',
        {
          sessionId: 'session-1',
          _meta: { isReplay: true },
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Old' } }
        },
        1000
      )
    ).toEqual([])
  })
})
