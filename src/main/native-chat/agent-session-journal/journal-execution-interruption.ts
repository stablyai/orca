import { z } from 'zod'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalStopEvent } from './journal-row-schema'
import type { JournalCancellationTarget } from './journal-cancellation-targets'
import type { JournalExecutionOrigin } from './journal-execution-item'

const position = z.object({ epoch: z.string(), sequence: z.number() })
const request = position.extend({
  event: z.object({
    reason: z.enum(['user-stop', 'user-close']),
    at: z.number(),
    turnId: z.string().optional(),
    caller: z.string().optional()
  })
})
export const executionInterruptionSchema = z.object({
  owner: position.extend({
    itemId: z.string(),
    ownerFence: z.number(),
    sequenceIndex: z.number().optional()
  }),
  target: z.object({
    ownerFence: z.number(),
    turnId: z.string().optional(),
    clientMessageId: z.string().optional(),
    executionId: z.string().optional()
  }),
  first: request,
  userStop: request.optional(),
  observedAt: z.number(),
  sequence: z.number()
})
export type AcceptedInterruption = {
  epoch: string
  sequence: number
  event: Omit<JournalStopEvent, 'targets'> & { reason: 'user-stop' | 'user-close' }
}
export type ExecutionInterruption = {
  owner: {
    epoch: string
    sequence: number
    sequenceIndex?: number
    itemId: string
    ownerFence: number
  }
  target: JournalCancellationTarget
  first: AcceptedInterruption
  userStop?: AcceptedInterruption
  observedAt: number
  sequence: number
}
export type JournalOwnedItem = AgentJournalRenderItem & {
  executionInterruption?: ExecutionInterruption
  executionOrigin?: JournalExecutionOrigin
}

export function publicJournalItem(item: JournalOwnedItem): AgentJournalRenderItem {
  if (item.executionInterruption === undefined && item.executionOrigin === undefined) {
    return item
  }
  const { executionInterruption: _private, executionOrigin: _origin, ...visible } = item
  return visible
}

export type JournalItemProvenance = {
  ownerFence?: number
  executionOwner?: number
  executionInterruption?: ExecutionInterruption
  executionOrigin?: JournalExecutionOrigin
}
export function publicJournalRunningTurn(
  running: { item: JournalOwnedItem; turnId: string } | null
) {
  return running ? { ...running, item: publicJournalItem(running.item) } : null
}

export function publicJournalItemAt(items: ReadonlyMap<string, JournalOwnedItem>, itemId: string) {
  const item = items.get(itemId)
  return item ? publicJournalItem(item) : null
}
