import type { IPtyProvider } from '../providers/types'
import type { OrcaRuntimeService } from './orca-runtime'
import { listRegisteredPtys } from '../memory/pty-registry'
import { isPathInsideOrEqual } from '../../shared/cross-platform-path'
import { splitWorktreeIdForFilesystem } from '../../shared/worktree-id'
import { mapWithConcurrency } from '../../shared/map-with-concurrency'

// Why: normal inventories still coalesce into one process scan, while a stale
// or pathological inventory cannot fan out unbounded provider/RPC shutdowns.
const WORKTREE_TEARDOWN_CONCURRENCY = 32

export type WorktreeTeardownDeps = {
  runtime?: OrcaRuntimeService
  localProvider: IPtyProvider
  onPtyStopped?: (ptyId: string) => void
  timeoutMs?: number
  requirePhysicalStop?: boolean
  includeLocalRegistry?: boolean
}

export type WorktreeTeardownResult = {
  runtimeStopped: number
  providerStopped: number
  registryStopped: number
}

export const WORKTREE_PROCESS_SWEEP_TIMEOUT_MS = 10_000

// Why: margin so a bounded daemon RPC rejects BEFORE the sweep deadline and its
// rejection can propagate — otherwise the outer deadline wins with a confusing
// "Timed out waiting for physical PTY teardown" instead of the accurate stop failure.
export const WORKTREE_TEARDOWN_RPC_MARGIN_MS = 500

// Absolute deadline (epoch ms) threaded into provider RPCs on the destructive
// path; each RPC leaf converts it to the remaining time when it actually issues,
// so sequential RPCs share one budget without any relative-timeout bookkeeping.
export function teardownRpcDeadline(sweepDeadline: number): number {
  return sweepDeadline - WORKTREE_TEARDOWN_RPC_MARGIN_MS
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
 * Sweeps are best-effort by default. Destructive removal callers set
 * `requirePhysicalStop` so a timeout or unproven stop blocks filesystem work.
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
  const deadline = Date.now() + Math.max(1, deps.timeoutMs ?? WORKTREE_PROCESS_SWEEP_TIMEOUT_MS)
  const deadlineError = new Error(`Timed out waiting for physical PTY teardown: ${worktreeId}`)
  const worktreePath = splitWorktreeIdForFilesystem(worktreeId)?.worktreePath
  const stopAttempts = new Map<string, Promise<boolean>>()
  const stopPty = (
    ptyId: string,
    stop: () => boolean | Promise<boolean>
  ): Promise<{ stopped: boolean; owner: boolean }> => {
    const previous = stopAttempts.get(ptyId) ?? Promise.resolve(false)
    const current = previous
      .then(async (stopped) => {
        if (stopped) {
          return { stopped: true, owner: false }
        }
        const didStop = await stop()
        return { stopped: didStop, owner: didStop }
      })
      .catch(() => ({ stopped: false, owner: false }))
    stopAttempts.set(
      ptyId,
      current.then(({ stopped }) => stopped)
    )
    return current
  }

  // Why: headless CLI has no ready renderer graph; only that known sentinel
  // may fall through to the provider and registry physical-owner sweeps.
  const runtimeSweep = deps.runtime
    ? settleBeforeDeadline(
        () => deps.runtime!.stopTerminalsForWorktree(worktreeId, { deadline, stopPty }),
        { stopped: 0 },
        deadline,
        deps.requirePhysicalStop ? deadlineError : undefined,
        (error) => !(error instanceof Error && error.message === 'runtime_unavailable')
      )
    : Promise.resolve({ stopped: 0 })
  const providerSweep = settleBeforeDeadline(
    () =>
      sweepProviderByPrefix(
        worktreeId,
        worktreePath,
        deps.localProvider,
        deadline,
        stopPty,
        deps.onPtyStopped,
        deps.requirePhysicalStop
      ),
    0,
    deadline,
    deps.requirePhysicalStop ? deadlineError : undefined
  )
  const registrySweep =
    deps.includeLocalRegistry === false
      ? Promise.resolve(0)
      : settleBeforeDeadline(
          () =>
            sweepRegistryForWorktree(
              worktreeId,
              deps.localProvider,
              deadline,
              stopPty,
              deps.onPtyStopped
            ),
          0,
          deadline,
          deps.requirePhysicalStop ? deadlineError : undefined
        )
  const [runtimeResult, providerStopped, registryStopped] = await Promise.all([
    runtimeSweep,
    providerSweep,
    registrySweep
  ])
  result.runtimeStopped = runtimeResult.stopped
  result.providerStopped = providerStopped
  result.registryStopped = registryStopped
  if (deps.requirePhysicalStop) {
    const stops = await Promise.all(stopAttempts.values())
    if (stops.some((stopped) => !stopped)) {
      throw new Error(`Failed to physically stop every PTY for worktree: ${worktreeId}`)
    }
  }

  return result
}

async function settleBeforeDeadline<T>(
  run: () => Promise<T>,
  fallback: T,
  deadline: number,
  failClosedError?: Error,
  failClosedOnRunError: (error: unknown) => boolean = () => true
): Promise<T> {
  const remaining = deadline - Date.now()
  if (remaining <= 0) {
    if (failClosedError) {
      throw failClosedError
    }
    return fallback
  }
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (value: T): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const fail = (error: unknown): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      reject(error)
    }
    const timer = setTimeout(
      () => (failClosedError ? fail(failClosedError) : finish(fallback)),
      remaining
    )
    timer.unref?.()
    void run().then(finish, (error: unknown) =>
      failClosedError && failClosedOnRunError(error) ? fail(error) : finish(fallback)
    )
  })
}

async function sweepProviderByPrefix(
  worktreeId: string,
  worktreePath: string | undefined,
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
  const rpcDeadline = teardownRpcDeadline(deadline)
  const sessions = failClosed
    ? await provider.listProcesses({ deadlineMs: rpcDeadline })
    : await provider.listProcesses({ deadlineMs: rpcDeadline }).catch(() => [])
  const ownedSessions = sessions.filter((session) => {
    // Why: older daemon/relay process rows may omit cwd; their established ID
    // and authoritative worktree ownership must remain usable during teardown.
    const cwdOwned =
      worktreePath !== undefined &&
      session.worktreeId === undefined &&
      typeof session.cwd === 'string' &&
      session.cwd.length > 0 &&
      isPathInsideOrEqual(worktreePath, session.cwd)
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

async function sweepRegistryForWorktree(
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
