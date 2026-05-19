import type { GlobalSettings } from '../../shared/types'

/** Precedence: per-worktree override (if it points to a known account) →
 *  global default → null. Pure: no side effects. */
export function resolveActiveClaudeAccountId(
  settings: GlobalSettings,
  worktreeId: string | undefined
): string | null {
  const overrideMap = settings.claudeAccountIdByWorkspace ?? {}
  const knownAccountIds = new Set(settings.claudeManagedAccounts.map((a) => a.id))

  if (worktreeId) {
    const override = overrideMap[worktreeId]
    if (override && knownAccountIds.has(override)) {
      return override
    }
  }
  return settings.activeClaudeManagedAccountId ?? null
}
