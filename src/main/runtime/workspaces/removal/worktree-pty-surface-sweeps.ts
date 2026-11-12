import { shutdownProviderWithExitEvidence } from '../../../ipc/pty/provider/shutdown-detect'
import { isCurrentPtyExit } from '../../../ipc/pty/provider/ownership-state'
import type { PtyIncarnationId } from '../../../../shared/terminal/pty/lifecycle/pty-incarnation'
/** Sweep provider sessions and local registry independently of the teardown entrypoint to avoid a dependency cycle. */

import type { IPtyProvider, PtyShutdownEvidence } from '../../../providers/pty-provider-contract'
import {
  getRegisteredPty,
  listRegisteredPtys,
  type PtyRegistration
} from '../../../memory/pty-registry'
import type { PtyProcessInfo } from '../../../providers/pty-process-info'
import { worktreePtyOwnership } from '../../../providers/worktree-pty-ownership'
import { mapWithConcurrency } from '../../../../shared/map-with-concurrency'
import { teardownRpcDeadline } from './worktree-teardown-deadline'

// Bound provider/RPC fanout while allowing normal shutdown requests to coalesce into one process scan.
const WORKTREE_TEARDOWN_CONCURRENCY = 32

export async function sweepProviderByPrefix(
  worktreeId: string,
  provider: IPtyProvider,
  deadline: number,
  stopPty: (
    ptyId: string,
    stop: () => Promise<boolean>
  ) => Promise<{ stopped: boolean; owner: boolean }>,
  onPtyStopped?: (ptyId: string) => void,
  failClosed = false,
  suppliedSessions?: readonly PtyProcessInfo[],
  onExitConfirmed?: (id: string, incarnationId?: string, evidence?: PtyShutdownEvidence) => void
): Promise<number> {
  const rpcDeadline = teardownRpcDeadline(deadline)
  const sessions =
    suppliedSessions ??
    (failClosed
      ? await provider.listProcesses({ deadlineMs: rpcDeadline, worktreeId })
      : await provider.listProcesses({ deadlineMs: rpcDeadline, worktreeId }).catch(() => []))
  const ownedSessions = suppliedSessions ?? sessions.filter(worktreePtyOwnership(worktreeId))
  // Concurrent starts coalesce shutdown process scans; the bound prevents unbounded fanout.
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
          await shutdownProviderWithExitEvidence(provider, session.id, {
            immediate: true,
            deadlineMs: rpcDeadline,
            ...(suppliedSessions ? { establishedOwnerOnly: true as const } : {}),
            onExitEvidence: (evidence) =>
              onExitConfirmed?.(session.id, session.incarnationId, evidence),
            ...(session.incarnationId ? { expectedIncarnationId: session.incarnationId } : {})
          })
          return Date.now() < deadline
        } catch {
          return false
        }
      })
      if (stopResult.owner && Date.now() < deadline) {
        if (!suppliedSessions) {
          clearStoppedPtyState(session.id, onPtyStopped)
        }
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
  onPtyStopped?: (ptyId: string) => void,
  suppliedEntries?: readonly PtyRegistration[],
  expectedIncarnations?: ReadonlyMap<string, PtyProcessInfo['incarnationId']>,
  onExitConfirmed?: (id: string, incarnationId?: string, evidence?: PtyShutdownEvidence) => void
): Promise<number> {
  const rpcDeadline = teardownRpcDeadline(deadline)
  const entries = suppliedEntries ?? listRegisteredPtys().filter((r) => r.worktreeId === worktreeId)
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
          if (suppliedEntries && getRegisteredPty(entry.ptyId)?.worktreeId !== worktreeId) {
            return false
          }
          await shutdownProviderWithExitEvidence(localProvider, entry.ptyId, {
            immediate: true,
            deadlineMs: rpcDeadline,
            ...(suppliedEntries ? { establishedOwnerOnly: true as const } : {}),
            onExitEvidence: (evidence) =>
              onExitConfirmed?.(entry.ptyId, expectedIncarnations?.get(entry.ptyId), evidence),
            expectedIncarnationId: expectedIncarnations?.get(entry.ptyId)
          })
          return Date.now() < deadline
        } catch {
          return false
        }
      })
      if (stopResult.owner && Date.now() < deadline) {
        if (!suppliedEntries) {
          clearStoppedPtyState(entry.ptyId, onPtyStopped)
        }
        return 1
      }
      return 0
    }
  )
  return stopped.reduce<number>((count, value) => count + value, 0)
}

export function clearStoppedPtyState(
  ptyId: string,
  onPtyStopped?: (ptyId: string) => void,
  expectedIncarnationId?: PtyIncarnationId
): boolean {
  if (
    expectedIncarnationId &&
    !isCurrentPtyExit({ id: ptyId, incarnationId: expectedIncarnationId })
  ) {
    return false
  }
  try {
    // Daemon shutdown may omit local pty:exit; removal must still drop memory rows.
    onPtyStopped?.(ptyId)
    return true
  } catch {
    /* cleanup is best-effort and must not block git-level removal */
    return false
  }
}
