/**
 * The two PTY-surface sweeps `killAllProcessesForWorktree` fans out to.
 *
 * Split from the teardown entry point so that file stays under the line ceiling once the
 * structured-session sweep joined it. Each function owns one registration surface: the installed
 * provider's session list, and the local pty-registry.
 */

import type { IPtyProvider } from '../providers/types'
import { listRegisteredPtys } from '../memory/pty-registry'
import { isPathInsideOrEqual } from '../../shared/cross-platform-path'
import { splitWorktreeId, splitWorktreeIdForFilesystem } from '../../shared/worktree/id'
import { mapWithConcurrency } from '../../shared/map-with-concurrency'
import { teardownRpcDeadline } from './worktree-teardown-deadline'

// Why: normal inventories still coalesce into one process scan, while a stale
// or pathological inventory cannot fan out unbounded provider/RPC shutdowns.
const WORKTREE_TEARDOWN_CONCURRENCY = 32

export type WorktreeTeardownStopPty = (
  ptyId: string,
  stop: () => Promise<boolean>
) => Promise<{ stopped: boolean; owner: boolean }>

export async function sweepProviderByPrefix(
  worktreeId: string,
  provider: IPtyProvider,
  deadline: number,
  stopPty: (
    ptyId: string,
    stop: () => Promise<boolean>
  ) => Promise<{ stopped: boolean; owner: boolean }>,
  onPtyStopped?: (ptyId: string) => void,
  failClosed = false
): Promise<number> {
  const prefix = `${worktreeId}@@`
  // Why (#10252): the cwd fallback only proves ownership when the filesystem path
  // is the *whole* worktree path. A folder-workspace instance strips its
  // `::workspace:<uuid>` suffix to a checkout dir shared with sibling instances,
  // so leave the fallback unset whenever stripping shortened the path — else
  // deleting one instance would sweep the others.
  const fullWorktreePath = splitWorktreeId(worktreeId)?.worktreePath
  const cwdFallbackPath =
    splitWorktreeIdForFilesystem(worktreeId)?.worktreePath === fullWorktreePath
      ? fullWorktreePath
      : undefined
  const rpcDeadline = teardownRpcDeadline(deadline)
  const sessions = failClosed
    ? await provider.listProcesses({ deadlineMs: rpcDeadline })
    : await provider.listProcesses({ deadlineMs: rpcDeadline }).catch(() => [])
  const ownedSessions = sessions.filter((session) => {
    // Why: older daemon/relay process rows may omit cwd; their established ID
    // and authoritative worktree ownership must remain usable during teardown.
    const cwdOwned =
      cwdFallbackPath !== undefined &&
      session.worktreeId === undefined &&
      typeof session.cwd === 'string' &&
      session.cwd.length > 0 &&
      isPathInsideOrEqual(cwdFallbackPath, session.cwd)
    return session.id.startsWith(prefix) || session.worktreeId === worktreeId || cwdOwned
  })
  // Why: agent shutdown snapshots coalesce only when requests begin together;
  // bounded concurrency avoids serial process scans without unbounded fanout.
  const stopped = await mapWithConcurrency(
    ownedSessions,
    WORKTREE_TEARDOWN_CONCURRENCY,
    async (session) => {
      if (Date.now() >= deadline) {
        return 0
      }
      const stopResult = await stopPty(session.id, async () => {
        if (Date.now() >= deadline) {
          return false
        }
        try {
          await provider.shutdown(session.id, { immediate: true, deadlineMs: rpcDeadline })
          return Date.now() < deadline
        } catch {
          return false
        }
      })
      if (stopResult.owner && Date.now() < deadline) {
        clearStoppedPtyState(session.id, onPtyStopped)
        return 1
      }
      return 0
    }
  )
  return stopped.reduce<number>((count, value) => count + value, 0)
}

export async function sweepRegistryForWorktree(
  worktreeId: string,
  localProvider: IPtyProvider,
  deadline: number,
  stopPty: (
    ptyId: string,
    stop: () => Promise<boolean>
  ) => Promise<{ stopped: boolean; owner: boolean }>,
  onPtyStopped?: (ptyId: string) => void
): Promise<number> {
  const rpcDeadline = teardownRpcDeadline(deadline)
  const entries = listRegisteredPtys().filter((r) => r.worktreeId === worktreeId)
  const stopped = await mapWithConcurrency(
    entries,
    WORKTREE_TEARDOWN_CONCURRENCY,
    async (entry) => {
      if (Date.now() >= deadline) {
        return 0
      }
      const stopResult = await stopPty(entry.ptyId, async () => {
        if (Date.now() >= deadline) {
          return false
        }
        try {
          await localProvider.shutdown(entry.ptyId, { immediate: true, deadlineMs: rpcDeadline })
          return Date.now() < deadline
        } catch {
          return false
        }
      })
      if (stopResult.owner && Date.now() < deadline) {
        clearStoppedPtyState(entry.ptyId, onPtyStopped)
        return 1
      }
      return 0
    }
  )
  return stopped.reduce<number>((count, value) => count + value, 0)
}

export function clearStoppedPtyState(ptyId: string, onPtyStopped?: (ptyId: string) => void): void {
  try {
    // Why: daemon shutdown does not always fan a local pty:exit event back
    // through pty.ts, but removed worktrees must immediately drop memory rows.
    onPtyStopped?.(ptyId)
  } catch {
    /* cleanup is best-effort and must not block git-level removal */
  }
}
