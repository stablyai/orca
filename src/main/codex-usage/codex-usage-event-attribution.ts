import { attributeUsageEvent } from '../usage/usage-event-attribution'
import type { UsageScanWorktreeRef } from '../usage/usage-provider-contract'
import type { UsageWorktreeResolver } from '../usage/usage-worktree-resolver'
import type { CodexUsageAttributedEvent, CodexUsageParsedEvent } from './types'
import { toWindowsWslUncPath } from '../../shared/wsl-paths'

export type CodexUsageWorktreeRef = UsageScanWorktreeRef

export async function attributeCodexUsageEvent(
  event: CodexUsageParsedEvent,
  resolveWorktree: UsageWorktreeResolver,
  sourceDistro?: string
): Promise<CodexUsageAttributedEvent | null> {
  const cwd =
    sourceDistro && event.cwd?.startsWith('/') && !event.cwd.startsWith('//')
      ? toWindowsWslUncPath(event.cwd, sourceDistro)
      : event.cwd
  return attributeUsageEvent(cwd === event.cwd ? event : { ...event, cwd }, resolveWorktree)
}
