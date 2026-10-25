import { afterEach, describe, expect, it } from 'vitest'
import {
  closeProviderTimelineRigs,
  SESSION
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { recordingStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger-test-support'
import { acpLaunchSpecFor } from './acp-launch-specs'
import {
  openAcpAdapterRig,
  PROVIDER_SESSION,
  sendHello,
  waitFor
} from './acp-structured-adapter.test-support'

afterEach(closeProviderTimelineRigs)

describe.each(['omp', 'opencode', 'grok'] as const)('%s provider message ownership', (agent) => {
  it.each([
    { stopReason: 'end_turn', nextPrompt: false },
    { stopReason: 'cancelled', nextPrompt: false },
    { stopReason: 'end_turn', nextPrompt: true },
    { stopReason: 'cancelled', nextPrompt: true }
  ] as const)(
    'refuses a late answer after $stopReason (next prompt: $nextPrompt)',
    async ({ stopReason, nextPrompt }) => {
      const recording = recordingStructuredAgentSessionLogger()
      let prompts = 0
      const rig = await openAcpAdapterRig({
        spec: acpLaunchSpecFor(agent)!,
        deps: { logger: recording.logger },
        script: (scripted) => {
          scripted.on('session/prompt', (frame) => {
            prompts += 1
            scripted.notify('session/update', {
              sessionId: PROVIDER_SESSION,
              _meta: { promptId: `prompt:send-${prompts}` },
              update: {
                sessionUpdate: 'agent_thought_chunk',
                messageId: prompts === 1 ? 'first-message' : 'next-message',
                content: { type: 'text', text: `Thought ${prompts}` }
              }
            })
            if (prompts === 1) {
              scripted.reply(frame, { stopReason })
            }
          })
        }
      })
      await rig.acquire()
      await sendHello(rig, 'send-1')
      await waitFor(async () =>
        expect(await rig.rig.turns()).toMatchObject([
          { state: stopReason === 'cancelled' ? 'interrupted' : 'completed' }
        ])
      )
      if (nextPrompt) {
        await sendHello(rig, 'send-2')
        await waitFor(async () => expect(await rig.rig.turns()).toHaveLength(2))
      }
      rig.child().agent.notify('session/update', {
        sessionId: PROVIDER_SESSION,
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'first-message',
          content: { type: 'text', text: 'Private late answer' }
        }
      })
      await waitFor(() =>
        expect(recording.entries).toContainEqual({
          level: 'warn',
          message: 'ACP text chunk rejected by its message stream',
          fields: {
            scope: 'acp-text-turn-settled',
            reason: 'turn-settled',
            sessionId: SESSION,
            providerSessionId: PROVIDER_SESSION,
            agent,
            generation: 'gen-acp',
            itemId: 'message:["first-message","assistant"]',
            channel: 'assistant',
            threadId: PROVIDER_SESSION,
            turnId: 'prompt:send-1'
          }
        })
      )
      if (nextPrompt) {
        rig.child().agent.notify('session/update', {
          sessionId: PROVIDER_SESSION,
          _meta: { promptId: 'prompt:send-2' },
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'next-message',
            content: { type: 'text', text: 'Next answer' }
          }
        })
        rig.child().agent.reply(await rig.frame('session/prompt', 1), { stopReason: 'end_turn' })
        await waitFor(async () =>
          expect(await rig.rig.turns()).toMatchObject([
            { state: stopReason === 'cancelled' ? 'interrupted' : 'completed' },
            { state: 'completed', outcome: 'success' }
          ])
        )
      }
      const rows = await rig.rig.rows()
      expect(
        rows
          .filter((row) => row.body.kind === 'message' && row.body.role === 'assistant')
          .map((row) => row.body)
      ).toMatchObject(nextPrompt ? [{ blocks: [{ text: 'Next answer' }] }] : [])
      expect(rows.filter((row) => row.body.kind === 'status')).toEqual([])
      await rig.adapter.closeSession(SESSION)
    }
  )
})
