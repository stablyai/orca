import { attributeUsageEvent } from '../usage/usage-event-attribution'
import type { UsageScanWorktreeRef } from '../usage/usage-provider-contract'
import type { UsageWorktreeResolver } from '../usage/usage-worktree-resolver'
import type { CodexUsageAttributedEvent, CodexUsageParsedEvent } from './types'

export type CodexUsageWorktreeRef = UsageScanWorktreeRef

export async function attributeCodexUsageEvent(
  event: CodexUsageParsedEvent,
  resolveWorktree: UsageWorktreeResolver
): Promise<CodexUsageAttributedEvent | null> {
  return attributeUsageEvent(event, resolveWorktree)
}
