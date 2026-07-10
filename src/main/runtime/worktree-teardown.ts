import type { IPtyProvider } from '../providers/types'
import type { OrcaRuntimeService } from './orca-runtime'
import { listRegisteredPtys } from '../memory/pty-registry'

export type WorktreeTeardownDeps = {
  runtime?: OrcaRuntimeService
  localProvider: IPtyProvider
  onPtyStopped?: (ptyId: string) => void
}

export type WorktreeTeardownResult = {
  runtimeStopped: number
  providerStopped: number
  registryStopped: number
}

/**
 * Kills every PTY we can prove belongs to `worktreeId`, across all three
 * registration surfaces (renderer graph, installed PTY provider session list,
 * local pty-registry).
 *
 * Why all three:
 *  - runtime.leaves is authoritative when the renderer is attached, but is
 *    empty in the headless-CLI case (see design §2b).
 *  - The installed provider's listProcesses() surfaces daemon sessions by
 *    the `${worktreeId}@@` session-id contract (§3.1). Because daemon-init
 *    installs the daemon adapter AS the localProvider via
 *    setLocalPtyProvider(), a single call reaches the right backend in both
 *    daemon-on and daemon-off configurations. LocalPtyProvider uses numeric
 *    ids, so the prefix filter is a safe no-op when the daemon is absent.
 *  - pty-registry covers the fallback local provider case and is the
 *    canonical source for memory attribution; it also redundantly backstops
 *    daemon spawns.
 *
 * Best-effort throughout: each sweep catches its own errors. The caller
 * (removeManagedWorktree, worktrees:remove IPC) must run the git-level
 * removal regardless of what this returns.
 */
export async function killAllProcessesForWorktree(
  worktreeId: string,
  deps: WorktreeTeardownDeps
): Promise<WorktreeTeardownResult> {
  const result: WorktreeTeardownResult = {
    runtimeStopped: 0,
    providerStopped: 0,
    registryStopped: 0
  }

  if (deps.runtime) {
    const r = await deps.runtime.stopTerminalsForWorktree(worktreeId).catch(() => ({ stopped: 0 }))
    result.runtimeStopped = r.stopped
  }

  result.providerStopped = await sweepProviderByPrefix(
    worktreeId,
    deps.localProvider,
    deps.onPtyStopped
  )
  result.registryStopped = await sweepRegistryForWorktree(
    worktreeId,
    deps.localProvider,
    deps.onPtyStopped
  )

  return result
}

async function sweepProviderByPrefix(
  worktreeId: string,
  provider: IPtyProvider,
  onPtyStopped?: (ptyId: string) => void
): Promise<number> {
  const prefix = `${worktreeId}@@`
  const sessions = await provider.listProcesses().catch(() => [])
  let killed = 0
  for (const s of sessions) {
    if (!s.id.startsWith(prefix)) {
      continue
    }
    try {
      await provider.shutdown(s.id, { immediate: true })
      clearStoppedPtyState(s.id, onPtyStopped)
      killed += 1
    } catch {
      // Already dead, or the backend dropped the session — treat as success.
      killed += 1
    }
  }
  return killed
}

async function sweepRegistryForWorktree(
  worktreeId: string,
  localProvider: IPtyProvider,
  onPtyStopped?: (ptyId: string) => void
): Promise<number> {
  const entries = listRegisteredPtys().filter((r) => r.worktreeId === worktreeId)
  let killed = 0
  for (const entry of entries) {
    try {
      await localProvider.shutdown(entry.ptyId, { immediate: true })
      clearStoppedPtyState(entry.ptyId, onPtyStopped)
      killed += 1
    } catch {
      /* ignore — best-effort */
    }
  }
  return killed
}

function clearStoppedPtyState(ptyId: string, onPtyStopped?: (ptyId: string) => void): void {
  if (!onPtyStopped) {
    return
  }
  try {
    // Why: daemon shutdown does not always fan a local pty:exit event back
    // through pty.ts, but removed worktrees must immediately drop memory rows.
    onPtyStopped(ptyId)
  } catch {
    /* cleanup is best-effort and must not block git-level removal */
  }
}
