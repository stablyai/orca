/** Translates ZCode headless stream-json records into the provider-neutral timeline events the shared
 *  assembler journals. Only `turn.open` starts a turn; the terminal `result` record is the runner's
 *  completion proof, not a timeline event. See docs/HEADLESS.md for the record contract. */

import type { ProviderTimelineEvent } from '../../native-chat/agent-session-timeline/provider-timeline-event'
import {
  isZcodeResultRecord,
  zcodeStreamingPayload,
  type ZcodeStreamRecord
} from './zcode-stream-records'

const ASSISTANT_STREAM = 'assistant'
const REASONING_STREAM = 'reasoning'

/** Map ZCode's `tool.*` records to a one-line activity row; the call details stay in the frame. */
function toolActivity(record: ZcodeStreamRecord): string | null {
  if (!record.type.startsWith('tool')) {
    return null
  }
  const name = record.payload?.toolName ?? record.payload?.name
  const verb =
    record.type.endsWith('_end') || record.type.endsWith('.completed') ? 'Ran' : 'Running'
  return typeof name === 'string' && name.length > 0 ? `${verb} ${name}` : 'Running a tool'
}

export class ZcodeTimelineTranslator {
  private assistantSeen = false
  private reasoningSeen = false

  /** Turn open precedes its acceptance so the send binds to the turn it started. */
  beginTurn(input: {
    clientMessageId: string
    requestedAt: number
    turnId: string
  }): ProviderTimelineEvent[] {
    this.assistantSeen = false
    this.reasoningSeen = false
    return [
      { type: 'turn.open', turn: input.turnId, at: input.requestedAt },
      {
        type: 'input.accepted',
        clientMessageId: input.clientMessageId,
        requestedAt: input.requestedAt,
        join: { turn: input.turnId }
      }
    ]
  }

  /** Null when the record carries nothing the journal should show. */
  frame(record: ZcodeStreamRecord): ProviderTimelineEvent[] | null {
    const streaming = zcodeStreamingPayload(record)
    if (streaming) {
      const delta = typeof streaming.delta === 'string' ? streaming.delta : ''
      if (streaming.kind === 'reasoning_delta' && delta.length > 0) {
        this.reasoningSeen = true
        return [
          {
            type: 'text.delta',
            item: { stream: REASONING_STREAM },
            channel: 'reasoning',
            text: delta
          }
        ]
      }
      if (streaming.kind === 'text_delta' && delta.length > 0) {
        this.assistantSeen = true
        return [
          {
            type: 'text.delta',
            item: { stream: ASSISTANT_STREAM },
            channel: 'assistant',
            text: delta
          }
        ]
      }
      return null
    }
    if (isZcodeResultRecord(record)) {
      return null
    }
    const activity = toolActivity(record)
    if (activity) {
      return [{ type: 'activity', text: activity }]
    }
    if (record.type === 'session.titleUpdated' || record.type === 'session.updated') {
      return null
    }
    if (record.type === 'turn.started' || record.type === 'turn.completed') {
      return null
    }
    // Unmodeled traffic stays visible through the bounded fallback row.
    return [{ type: 'provider.frame', frameKind: record.type, payload: record.payload ?? null }]
  }

  /** Seal streamed text against the provider's final answer, then end the turn. */
  finish(input: {
    turnId: string
    at: number
    response: string | null
    interrupted: boolean
  }): ProviderTimelineEvent[] {
    const events: ProviderTimelineEvent[] = []
    const finalText = input.response?.trim() ?? ''
    if (this.reasoningSeen) {
      events.push({
        type: 'text.close',
        item: { stream: REASONING_STREAM },
        join: { turn: input.turnId }
      })
    }
    if (this.assistantSeen) {
      events.push({
        type: 'text.close',
        item: { stream: ASSISTANT_STREAM },
        join: { turn: input.turnId },
        ...(finalText.length > 0 ? { text: finalText } : {})
      })
    } else if (finalText.length > 0) {
      // A provider that only emitted the terminal answer still opens and closes a message.
      events.push({
        type: 'text.delta',
        item: { stream: ASSISTANT_STREAM },
        channel: 'assistant',
        text: finalText,
        join: { turn: input.turnId }
      })
      events.push({
        type: 'text.close',
        item: { stream: ASSISTANT_STREAM },
        join: { turn: input.turnId }
      })
    }
    events.push({
      type: 'turn.end',
      turn: input.turnId,
      at: input.at,
      state: input.interrupted ? 'interrupted' : 'completed',
      ...(input.interrupted ? {} : { outcome: 'success' as const })
    })
    return events
  }
}
