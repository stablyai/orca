import { attributeUsageEvent } from '../usage/worktree-attribution/usage-event-attribution'
import type { UsageScanWorktreeRef } from '../usage/provider-lifecycle/usage-provider-contract'
import type { UsageWorktreeResolver } from '../usage/worktree-attribution/usage-worktree-resolver'
import type { CodexUsageAttributedEvent, CodexUsageParsedEvent } from './types'

export type CodexUsageWorktreeRef = UsageScanWorktreeRef

export async function attributeCodexUsageEvent(
  event: CodexUsageParsedEvent,
  resolveWorktree: UsageWorktreeResolver
): Promise<CodexUsageAttributedEvent | null> {
  return attributeUsageEvent(event, resolveWorktree)
}
