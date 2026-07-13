import type { IPtyProvider } from '../providers/types'
import type { OrcaRuntimeService } from './orca-runtime'
import { listRegisteredPtys } from '../memory/pty-registry'
import { parseAppSshPtyId } from '../../shared/ssh-pty-id'
import { mapPtyStopsWithConcurrency } from './pty-stop-concurrency'

export type WorktreeTeardownDeps = {
  runtime?: OrcaRuntimeService
  localProvider: IPtyProvider
  connectionId?: string | null
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
 * Provider and registry ownership overlap, so their targets are deduplicated
 * before shutdown. Any stop that cannot be verified fails closed: Git removal
 * must never race a shell whose cwd still belongs to the worktree.
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
  let failedPtyIds: string[] = []

  if (deps.runtime) {
    const r = await deps.runtime.stopTerminalsForWorktree(worktreeId, {
      worktreeTeardown: true,
      ...(deps.connectionId !== undefined ? { connectionId: deps.connectionId } : {})
    })
    result.runtimeStopped = r.stopped
    failedPtyIds = 'failedPtyIds' in r ? (r.failedPtyIds ?? []) : []
  }

  const failedRemotePtyIds = failedPtyIds.filter((ptyId) => parseAppSshPtyId(ptyId) !== null)
  const failedLocalPtyIds = failedPtyIds.filter((ptyId) => parseAppSshPtyId(ptyId) === null)
  const fallbackResult = deps.connectionId
    ? { providerStopped: 0, registryStopped: 0 }
    : await sweepLocalProvider(worktreeId, deps.localProvider, failedLocalPtyIds, (ptyId) => {
        clearStoppedPtyState(ptyId, deps.onPtyStopped)
        // Why: provider shutdown and already-absent fallbacks do not always emit
        // an exit event, so retire the runtime record before Git removes its cwd.
        deps.runtime?.onPtyExit?.(ptyId, -1)
      })
  result.providerStopped = fallbackResult.providerStopped
  result.registryStopped = fallbackResult.registryStopped

  if (failedRemotePtyIds.length > 0) {
    // Why: the local provider cannot prove an SSH-owned PTY dead; remote Git
    // removal must not proceed after an unverified exact stop.
    throw new Error(`Failed to stop remote worktree terminals: ${failedRemotePtyIds.join(', ')}`)
  }

  return result
}

async function sweepLocalProvider(
  worktreeId: string,
  provider: IPtyProvider,
  failedLocalPtyIds: readonly string[],
  retirePty?: (ptyId: string) => void
): Promise<{ providerStopped: number; registryStopped: number }> {
  const prefix = `${worktreeId}@@`
  const sessions = await provider.listProcesses()
  const targets = new Map<string, 'provider' | 'registry'>()
  for (const session of sessions) {
    if (session.id.startsWith(prefix)) {
      targets.set(session.id, 'provider')
    }
  }
  for (const entry of listRegisteredPtys()) {
    if (entry.worktreeId === worktreeId && !targets.has(entry.ptyId)) {
      targets.set(entry.ptyId, 'registry')
    }
  }
  for (const ptyId of failedLocalPtyIds) {
    if (!targets.has(ptyId)) {
      targets.set(ptyId, 'registry')
    }
  }

  const failedShutdowns = new Map<string, unknown>()
  const stopped = new Set<string>()
  await mapPtyStopsWithConcurrency([...targets.keys()], async (ptyId) => {
    try {
      await provider.shutdown(ptyId, { immediate: true })
      stopped.add(ptyId)
      retirePty?.(ptyId)
    } catch (error) {
      failedShutdowns.set(ptyId, error)
    }
  })

  if (failedShutdowns.size > 0) {
    // Why: duplicate/stale registry rows may report "not found" after another
    // owner already stopped the PTY. Only an authoritative post-sweep absence
    // converts that rejection into verified success.
    const remainingIds = new Set((await provider.listProcesses()).map((session) => session.id))
    const unverified = [...failedShutdowns.keys()].filter((ptyId) => remainingIds.has(ptyId))
    if (unverified.length > 0) {
      throw new Error(`Failed to stop local worktree terminals: ${unverified.join(', ')}`)
    }
    for (const ptyId of failedShutdowns.keys()) {
      retirePty?.(ptyId)
    }
  }

  let providerStopped = 0
  let registryStopped = 0
  for (const [ptyId, owner] of targets) {
    if (!stopped.has(ptyId)) {
      continue
    }
    if (owner === 'provider') {
      providerStopped += 1
    } else {
      registryStopped += 1
    }
  }
  return { providerStopped, registryStopped }
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
