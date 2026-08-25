import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'
import { splitWorktreeIdForFilesystem } from '../../../../shared/worktree/id'
import type { IPtyProvider } from '../../../providers/types'
import { beginTerminalInstall } from '../../watcher-removal-gate'

export function isClaudeLaunchCommand(command: string | undefined): boolean {
  if (!command) {
    return false
  }
  return /(^|[\s;&|('"`])(?:[^\s;&|('"`]*[\\/])?claude(?:\.cmd|\.exe)?($|[\s;&|)'"`])/i.test(
    command
  )
}

export function routesFreshSpawnsToLocalProvider(provider: IPtyProvider): boolean {
  return provider.routesFreshSpawnsToLocalProvider === true
}

export function recoverFreshSpawnProviderRouting(
  provider: IPtyProvider,
  connectionId: string | null | undefined,
  sessionId: string | undefined,
  isNewSession = sessionId === undefined
): Promise<boolean> | undefined {
  if (connectionId || (!isNewSession && sessionId) || !routesFreshSpawnsToLocalProvider(provider)) {
    return
  }
  return provider.recoverFreshSpawnRouting?.()
}

export function beginPtySpawnForWorktree(
  worktreeId: string | undefined,
  cwd: string | undefined,
  connectionId: string | null | undefined
): () => void {
  const worktreePath = worktreeId
    ? splitWorktreeIdForFilesystem(worktreeId)?.worktreePath
    : undefined
  const installPaths = new Map<string, string>()
  for (const candidate of [worktreePath, cwd]) {
    if (candidate) {
      installPaths.set(normalizeRuntimePathForComparison(candidate), candidate)
    }
  }
  const finishes: (() => void)[] = []
  try {
    for (const candidate of installPaths.values()) {
      finishes.push(beginTerminalInstall(candidate, connectionId ?? undefined))
    }
  } catch (error) {
    // Why: worktree ID and cwd can be different roots; release earlier admissions before rejecting.
    finishes.toReversed().forEach((finish) => finish())
    throw error
  }
  return () => finishes.toReversed().forEach((finish) => finish())
}
