import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  closeProviderTimelineRigs,
  openProviderTimelineRig
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { recordingStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger-test-support'
import { acpLaunchSpecFor } from './acp-launch-specs'
import { AcpStructuredLane } from './acp-structured-lane'
import { AcpTimelineTranslator } from './acp-timeline-translator'

afterEach(async () => {
  vi.restoreAllMocks()
  await closeProviderTimelineRigs()
})

describe('shared ACP text identity', () => {
  it.each(['omp', 'opencode', 'grok'] as const)(
    'keeps interleaved reasoning and answers separate for %s',
    async (agent) => {
      const rig = await openProviderTimelineRig()
      const dialect = acpLaunchSpecFor(agent)!.dialect
      const lane = new AcpTimelineTranslator({ sessionId: 'provider-1', dialect })
      const prompt = lane.openPrompt('send-1', 1000)
      const events = [...prompt.events]
      for (const [sessionUpdate, text] of [
        ['agent_thought_chunk', 'Think '],
        ['agent_message_chunk', 'Answer '],
        ['agent_thought_chunk', 'more'],
        ['agent_message_chunk', 'complete']
      ]) {
        events.push(
          ...lane.notification(
            'session/update',
            {
              sessionId: 'provider-1',
              _meta: { promptId: prompt.promptId },
              update: { sessionUpdate, messageId: 'one-message', content: { type: 'text', text } }
            },
            1100
          )
        )
      }
      events.push(...lane.promptResult('send-1', { stopReason: 'end_turn' }, 1200))
      for (const event of events) {
        expect(rig.assembler.apply(event)).toEqual({ admission: { accepted: true } })
      }
      expect(
        (await rig.rows()).filter((row) => row.body.kind === 'message').map((row) => row.body)
      ).toMatchObject([
        { role: 'reasoning', blocks: [{ text: 'Think more' }] },
        { role: 'assistant', blocks: [{ text: 'Answer complete' }] }
      ])
    }
  )

  it.each([false, true])(
    'diagnoses stream rejection without blocking settlement (logger throws: %s)',
    async (throws) => {
      const rig = await openProviderTimelineRig()
      const recording = recordingStructuredAgentSessionLogger()
      const fallback = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const lane = new AcpStructuredLane({
        sink: rig.sink,
        sessionId: 'chat-1',
        agent: 'omp',
        agentName: 'OMP',
        generation: 'generation-1',
        providerSessionId: 'provider-1',
        dialect: acpLaunchSpecFor('omp')!.dialect,
        logger: throws
          ? {
              warn: () => {
                throw new Error('logging failed')
              },
              error: recording.logger.error
            }
          : recording.logger,
        onInputAccepted: () => {},
        onFailed: () => {
          throw new Error('unexpected lane failure')
        }
      })
      lane.apply([
        { type: 'turn.open', turn: 'turn-1', at: 1000 },
        {
          type: 'text.delta',
          item: { id: 'invalid-message' },
          channel: 'reasoning',
          text: 'private thought',
          join: { thread: 'provider-1', turn: 'turn-1' }
        },
        {
          type: 'text.delta',
          item: { id: 'invalid-message' },
          channel: 'assistant',
          text: 'private answer',
          join: { thread: 'provider-1', turn: 'turn-1' }
        },
        { type: 'turn.end', turn: 'turn-1', at: 1200, state: 'completed', outcome: 'success' }
      ])
      if (throws) {
        expect(fallback).toHaveBeenCalledOnce()
        expect(await rig.turns()).toMatchObject([{ state: 'completed', outcome: 'success' }])
        lane.dispose()
        return
      }
      expect(recording.entries).toEqual([
        {
          level: 'warn',
          message: 'ACP text chunk rejected by its message stream',
          fields: {
            scope: 'acp-text-stream-mismatch',
            reason: 'stream-mismatch',
            sessionId: 'chat-1',
            providerSessionId: 'provider-1',
            agent: 'omp',
            generation: 'generation-1',
            itemId: 'invalid-message',
            channel: 'assistant',
            threadId: 'provider-1',
            turnId: 'turn-1',
            producerAgentId: undefined
          }
        }
      ])
      expect((await rig.rows()).filter((row) => row.body.kind === 'status')).toEqual([])
      lane.dispose()
    }
  )
})
