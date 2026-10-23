import { BoundedMap } from '../../shared/bounded-map'
import {
  backgroundTaskJournalBody,
  isSettledBackgroundTaskState
} from '../../shared/native-chat-background-task-row'
import type { NativeChatBackgroundTaskBlock } from '../../shared/native-chat-types'
import type {
  ProviderTimelineEvent,
  ProviderTimelineJoin
} from '../native-chat/agent-session-timeline/provider-timeline-event'
import type { AcpBackgroundTaskUpdate } from './acp-dialects/acp-dialect'

/** Retain running snapshots and bounded settled labels; the assembler owns durable placement. */
export class AcpBackgroundTaskTimeline {
  private readonly running = new Map<string, NativeChatBackgroundTaskBlock>()
  private readonly settled = new BoundedMap<string, NativeChatBackgroundTaskBlock>({
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
      const previous = this.running.get(update.taskId) ?? this.settled.get(update.taskId)
      const block: NativeChatBackgroundTaskBlock = {
        type: 'background-task',
        ...previous,
        ...fields,
        kind: update.kind ?? previous?.kind ?? fallbackKind ?? 'unknown',
        label: update.label ?? previous?.label ?? fallbackLabel ?? update.taskId,
        state: update.state
      }
      if (isSettledBackgroundTaskState(block.state)) {
        this.running.delete(block.taskId)
        this.settled.set(block.taskId, block)
      } else {
        this.settled.delete(block.taskId)
        this.running.set(block.taskId, block)
      }
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
