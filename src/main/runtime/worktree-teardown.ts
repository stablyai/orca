import type { IPtyProvider } from '../providers/types'
import type { OrcaRuntimeService } from './orca-runtime'
import { listRegisteredPtys } from '../memory/pty-registry'
import { shutdownPtyWithDrain } from '../providers/pty-shutdown-drain'
import { runWorktreePtyShutdownsWithBoundedConcurrency } from './worktree-pty-shutdown-concurrency'

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

  const stoppedProviderPtys = new Set<string>()
  result.providerStopped = await sweepProviderByPrefix(
    worktreeId,
    deps.localProvider,
    deps.onPtyStopped,
    stoppedProviderPtys
  )
  result.registryStopped = await sweepRegistryForWorktree(
    worktreeId,
    deps.localProvider,
    deps.onPtyStopped,
    stoppedProviderPtys
  )

  return result
}

async function sweepProviderByPrefix(
  worktreeId: string,
  provider: IPtyProvider,
  onPtyStopped: ((ptyId: string) => void) | undefined,
  stoppedProviderPtys: Set<string>
): Promise<number> {
  const prefix = `${worktreeId}@@`
  const sessions = await provider.listProcesses().catch(() => [])
  const ids = [...new Set(sessions.filter((s) => s.id.startsWith(prefix)).map((s) => s.id))]
  const results = await runWorktreePtyShutdownsWithBoundedConcurrency(ids, (id) =>
    stopPtyForWorktree(provider, id, onPtyStopped, true)
  )
  for (const [index, result] of results.entries()) {
    if (result.cleared) {
      stoppedProviderPtys.add(ids[index])
    }
  }
  return results.filter((result) => result.counted).length
}

async function sweepRegistryForWorktree(
  worktreeId: string,
  localProvider: IPtyProvider,
  onPtyStopped: ((ptyId: string) => void) | undefined,
  stoppedProviderPtys: Set<string>
): Promise<number> {
  const ids = [
    ...new Set(
      listRegisteredPtys()
        .filter((r) => r.worktreeId === worktreeId && !stoppedProviderPtys.has(r.ptyId))
        .map((r) => r.ptyId)
    )
  ]
  const results = await runWorktreePtyShutdownsWithBoundedConcurrency(ids, (id) =>
    stopPtyForWorktree(localProvider, id, onPtyStopped, false)
  )
  return results.filter((result) => result.counted).length
}

async function stopPtyForWorktree(
  provider: IPtyProvider,
  ptyId: string,
  onPtyStopped: ((ptyId: string) => void) | undefined,
  countErrorsAsStopped: boolean
): Promise<{ counted: boolean; cleared: boolean }> {
  try {
    // Why: drain-then-force keeps this bounded and reaps the PTY before
    // git-level worktree removal deletes files it may hold open (best-effort
    // on Windows — the taskkill wait resolves on a bounded timeout).
    await shutdownPtyWithDrain(provider, ptyId, {})
    clearStoppedPtyState(ptyId, onPtyStopped)
    return { counted: true, cleared: true }
  } catch {
    // Provider-list entries can disappear between list and kill; preserve the
    // old best-effort count while registry cleanup stays stricter.
    return { counted: countErrorsAsStopped, cleared: false }
  }
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
