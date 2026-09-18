import { attributeUsageEvent } from '../usage/usage-event-attribution'
import type { UsageWorktreeResolver } from '../usage/usage-worktree-resolver'
import type { DevinUsageAttributedEvent, DevinUsageParsedEvent } from './types'

export function attributeDevinUsageEvent(
  event: DevinUsageParsedEvent,
  resolveWorktree: UsageWorktreeResolver
): DevinUsageAttributedEvent | null {
  return attributeUsageEvent(event, resolveWorktree)
}
