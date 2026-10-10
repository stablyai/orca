import { BoundedMap } from '../../shared/bounded-map'
import { backgroundTaskJournalBody } from '../../shared/native-chat-background-task-row'
import type { NativeChatBackgroundTaskBlock } from '../../shared/native-chat-types'
import {
  boundInlineText,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS
} from '../native-chat/agent-session-journal/journal-payload-bounds'
import type {
  ProviderTimelineEvent,
  ProviderTimelineJoin
} from '../native-chat/agent-session-timeline/provider-timeline-event'
import type { AcpBackgroundTaskUpdate } from './acp-dialects/acp-dialect'

/** Partial provider snapshots only; the assembler owns settlement and durable placement. A task
 *  the bound evicted (128 others updated since) loses its earlier label, parent tool and output
 *  file on its next update; its row keeps the turn it was placed in. */
export class AcpBackgroundTaskTimeline {
  private readonly snapshots = new BoundedMap<string, NativeChatBackgroundTaskBlock>({
    maxEntries: 128,
    maxBytes: 1024 * 1024,
    sizeOf: (block, key) => Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(block))
  })

  constructor(private readonly toolTurn: (callId: string) => string | undefined) {}

  translate(
    updates: AcpBackgroundTaskUpdate[],
    join: ProviderTimelineJoin
  ): ProviderTimelineEvent[] {
    return updates.map((update) => {
      const { fallbackLabel, fallbackKind, ...fields } = update
      const previous = this.snapshots.get(update.taskId)
      const block: NativeChatBackgroundTaskBlock = {
        type: 'background-task',
        ...previous,
        ...fields,
        kind: update.kind ?? previous?.kind ?? fallbackKind ?? 'unknown',
        label: update.label ?? previous?.label ?? fallbackLabel ?? update.taskId,
        state: update.state
      }
      for (const key of ['label', 'summary', 'error', 'outputFile'] as const) {
        const text = block[key]
        if (text !== undefined) {
          block[key] = boundInlineText(text, DEFAULT_JOURNAL_PAYLOAD_LIMITS).text
        }
      }
      this.snapshots.set(block.taskId, block)
      const turn = block.parentToolUseId ? this.toolTurn(block.parentToolUseId) : undefined
      return {
        type: 'item.update',
        item: `background-task:${block.taskId}`,
        body: backgroundTaskJournalBody(block),
        join: { ...join, ...(turn === undefined ? {} : { turn }) }
      }
    })
  }
}
