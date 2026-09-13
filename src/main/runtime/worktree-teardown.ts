import type { IPtyProvider } from '../providers/types'
import type { OrcaRuntimeService } from './orca-runtime'
import {
  isUnstoppedPtyRemovalError,
  RUNNING_AGENT_SESSION_REMOVAL_PREFIX,
  UNSTOPPED_PTY_DETAIL_SEPARATOR,
  WORKTREE_TEARDOWN_FORCE_HINT,
  WORKTREE_TEARDOWN_TIMEOUT_PREFIX
} from '../../shared/worktree/removal'
import { settleBeforeDeadline } from './settle-before-deadline'
import {
  clearStoppedPtyState,
  sweepProviderByPrefix,
  sweepRegistryForWorktree
} from './worktree-pty-surface-sweeps'
import {
  closeStructuredSessionsForWorktree,
  createStructuredSweepProgress,
  describeUnclosedStructuredSessions,
  listLiveStructuredSessionsForWorktree,
  unclosedStructuredSessions
} from './structured-session-worktree-teardown'
import {
  createWorktreeSweepTracker,
  settleSweepsForForcedRemoval,
  type WorktreeSweepTracker
} from './forced-sweep-settlement'
import {
  describeError,
  describeFailedPtySweep,
  describeUnstoppedPtys,
  resolveUnstoppedPtyVerdict
} from './unstopped-pty-verification'

export type WorktreeTeardownDeps = {
  runtime?: OrcaRuntimeService
  /** Authoritative id for callers whose selector no longer resolves (orphaned workspace). */
  resolvedWorktreeId?: string
  /** SSH connection owning `resolvedWorktreeId`; prevents same-id cross-host graph matches. */
  resolvedConnectionId?: string
  /** Runtime environment owning a mirrored `resolvedWorktreeId`. */
  resolvedRuntimeEnvironmentId?: string
  localProvider: IPtyProvider
  onPtyStopped?: (ptyId: string) => void
  timeoutMs?: number
  requirePhysicalStop?: boolean
  /** Explicit Force Delete only: warn instead of throwing when a stop stays unproven (#11960). */
  allowUnverifiedStop?: boolean
  includeProviderInventory?: boolean
  includeLocalRegistry?: boolean
  /**
   * Close structured agent sessions best-effort, for a destructive removal that does NOT require
   * PTY-stop proof — the folder-workspace paths, which sweep and kill PTYs the same way.
   *
   * Separate from `requirePhysicalStop` because the two questions are different: that one asks
   * whether a stop must be PROVEN before files are touched, and it is what licenses a refusal.
   * Reconciliation sweeps set neither; they repair state and must never close anything.
   */
  closeStructuredSessions?: boolean
}

export type WorktreeTeardownResult = {
  runtimeStopped: number
  providerStopped: number
  registryStopped: number
  /** Structured agent sessions this teardown closed; absent when it closed none. */
  structuredStopped?: number
}

export const WORKTREE_PROCESS_SWEEP_TIMEOUT_MS = 10_000

export { WORKTREE_TEARDOWN_RPC_MARGIN_MS, teardownRpcDeadline } from './worktree-teardown-deadline'

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
 * `allowUnverifiedStop` waives that proof so the gate can never wedge a
 * workspace permanently (#11960) — it must come only from an explicit Force
 * Delete or `--force`, never from the `force` an ordinary confirmed delete
 * already sets to skip the dirty-file prompt.
 */
export async function killAllProcessesForWorktree(
  worktreeId: string,
  deps: WorktreeTeardownDeps
): Promise<WorktreeTeardownResult> {
  const sweepBudgetMs = Math.max(1, deps.timeoutMs ?? WORKTREE_PROCESS_SWEEP_TIMEOUT_MS)
  const deadline = Date.now() + sweepBudgetMs
  const deadlineError = new Error(
    `${WORKTREE_TEARDOWN_TIMEOUT_PREFIX} ${worktreeId}. ${WORKTREE_TEARDOWN_FORCE_HINT}`
  )
  const sweeps = createWorktreeSweepTracker()
  // ISSUED first, before a single PTY is touched: a structured agent session is registered on none
  // of the three surfaces below, so all three answered zero and removal deleted the checkout out
  // from under a running provider child. Asking the agent plane ahead of the terminal plane also
  // keeps an intentional stop from reading as a failed process exit.
  //
  // Not AWAITED first, though. Its close is serial and each one waits on a provider round trip, so
  // awaiting here would spend the shared budget before a single PTY was asked — and the sweeps
  // would then report a timeout for a stop they never attempted. It is joined below, ahead of the
  // PTY verdict, so a structured refusal still outranks one.
  const structuredSweep = sweepStructuredSessions(worktreeId, deps, deadline, sweeps)
  void structuredSweep.catch(() => undefined)
  const stopAttempts = new Map<string, Promise<boolean>>()
  const stopPty = (
    ptyId: string,
    stop: () => Promise<boolean>
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

  // Why: headless CLI has no ready renderer graph, and a just-created/removed
  // worktree may not resolve in the graph yet; either case means zero
  // runtime-owned PTYs, so both sentinels fall through instead of failing
  // destructive removal closed.
  const runtimeSweep = deps.runtime
    ? settleBeforeDeadline(
        sweeps.track(() =>
          deps.runtime!.stopTerminalsForWorktree(worktreeId, {
            deadline,
            stopPty,
            ...(deps.resolvedWorktreeId ? { resolvedWorktreeId: deps.resolvedWorktreeId } : {}),
            ...(deps.resolvedConnectionId
              ? { resolvedConnectionId: deps.resolvedConnectionId }
              : {}),
            ...(deps.resolvedRuntimeEnvironmentId
              ? { resolvedRuntimeEnvironmentId: deps.resolvedRuntimeEnvironmentId }
              : {})
          })
        ),
        { stopped: 0 },
        deadline,
        deps.requirePhysicalStop ? deadlineError : undefined,
        (error) =>
          !(
            error instanceof Error &&
            (error.message === 'runtime_unavailable' || error.message === 'selector_not_found')
          )
      )
    : Promise.resolve({ stopped: 0 })
  const providerSweep =
    deps.includeProviderInventory === false
      ? Promise.resolve(0)
      : settleBeforeDeadline(
          sweeps.track(() =>
            sweepProviderByPrefix(
              worktreeId,
              deps.localProvider,
              deadline,
              stopPty,
              deps.onPtyStopped,
              deps.requirePhysicalStop
            )
          ),
          0,
          deadline,
          deps.requirePhysicalStop ? deadlineError : undefined
        )
  const registrySweep =
    deps.includeLocalRegistry === false
      ? Promise.resolve(0)
      : settleBeforeDeadline(
          sweeps.track(() =>
            sweepRegistryForWorktree(
              worktreeId,
              deps.localProvider,
              deadline,
              stopPty,
              deps.onPtyStopped
            )
          ),
          0,
          deadline,
          deps.requirePhysicalStop ? deadlineError : undefined
        )
  // Why: a rejection here can outlive this call, and only one of the two paths
  // below observes every promise, so mark them all handled up front.
  for (const sweep of [runtimeSweep, providerSweep, registrySweep]) {
    void sweep.catch(() => undefined)
  }
  const structuredStopped = await structuredSweep
  let runtimeResult: { stopped: number }
  let providerStopped: number
  let registryStopped: number
  if (deps.allowUnverifiedStop) {
    const forced = await settleSweepsForForcedRemoval(
      worktreeId,
      { runtime: runtimeSweep, provider: providerSweep, registry: registrySweep },
      sweeps,
      deadlineError
    )
    if (forced.incomplete) {
      // Carries the structured count out too: this early return skips the PTY verdict, not the
      // sweep that already closed a user's chats, and dropping it makes the log say `structured=0`
      // for a removal that closed some.
      return { ...forced.stopped, ...(structuredStopped > 0 ? { structuredStopped } : {}) }
    }
    runtimeResult = { stopped: forced.stopped.runtimeStopped }
    providerStopped = forced.stopped.providerStopped
    registryStopped = forced.stopped.registryStopped
  } else {
    // Why: without the waiver a rejection aborts the removal and nothing is
    // deleted, so failing fast is safe — and keeps a dead host reporting
    // immediately instead of after the full sweep budget.
    try {
      ;[runtimeResult, providerStopped, registryStopped] = await Promise.all([
        runtimeSweep,
        providerSweep,
        registrySweep
      ])
    } catch (error) {
      // Why (#11960): this rejection is the provider's own wording, which the force
      // classifier cannot recognise — so the wedge Force Delete exists for was the one
      // failure that never offered it. Re-word it, keeping the original as the cause.
      throw deps.requirePhysicalStop && !isUnstoppedPtyRemovalError(describeError(error))
        ? new Error(
            `${describeFailedPtySweep(worktreeId, error)}. ${WORKTREE_TEARDOWN_FORCE_HINT}`,
            { cause: error }
          )
        : error
    }
  }
  if (deps.requirePhysicalStop) {
    const stopResults = await Promise.all(
      [...stopAttempts].map(async ([ptyId, stopped]) => [ptyId, await stopped] as const)
    )
    const failedPtyIds = stopResults.filter(([, stopped]) => !stopped).map(([ptyId]) => ptyId)
    const verdict = await resolveUnstoppedPtyVerdict(
      failedPtyIds,
      deps.localProvider,
      sweepBudgetMs,
      deps.includeProviderInventory !== false ||
        (deps.resolvedConnectionId === undefined &&
          deps.resolvedRuntimeEnvironmentId === undefined),
      deps.runtime
    )
    if (verdict.status === 'exited') {
      for (const ptyId of failedPtyIds) {
        clearStoppedPtyState(ptyId, deps.onPtyStopped)
      }
    } else {
      const summary = describeUnstoppedPtys(worktreeId, failedPtyIds, verdict)
      // Only a proof-requiring removal may refuse. A folder-workspace removal shares its root, so no
      // checkout disappears under the child — the harm is a session left pointing at a workspace Orca
      // has forgotten — and one of those paths is a never-throw forget, which a refusal would wedge.
      if (deps.requirePhysicalStop && !deps.allowUnverifiedStop) {
        throw new Error(`${summary}. ${WORKTREE_TEARDOWN_FORCE_HINT}`)
      }
      // Why: force is the documented escape hatch, so removal continues — but the
      // registry rows stay put. Dropping them would unregister a PTY we just saw
      // alive, so a retry could no longer find it and the user could never see it
      // (the discoverability half of #11960).
      console.warn(`[worktree-teardown] forcing removal despite unstopped PTYs — ${summary}`)
    }
  }

  return {
    runtimeStopped: runtimeResult.stopped,
    providerStopped,
    registryStopped,
    ...(structuredStopped > 0 ? { structuredStopped } : {})
  }
}

/**
 * The fourth sweep: structured agent sessions bound to this worktree, on this host.
 *
 * Stops first and refuses only on unproven stops, which is the bargain the unstopped-PTY gate
 * actually strikes: that gate kills every PTY — a terminal running an agent included — and refuses
 * only for the ones whose exit it could not then verify. Refusing merely because a session is
 * attached made an idle chat, which the user is done with, harder to delete than a terminal running
 * the same agent. Attachment is lease state, not work in flight, so it was never the right proxy.
 *
 * Two callers participate. A proof-requiring removal (`requirePhysicalStop`) refuses when a close
 * does not settle, so nothing deletes a checkout out from under a child that is still there. A
 * folder-workspace removal (`closeStructuredSessions`) never refuses: it shares its root so no
 * checkout vanishes under the child, and every one of those call sites discards a rejection, so a
 * refusal there would be words nobody reads. Reconciliation sweeps set neither — they repair state,
 * delete nothing, and must never close a session.
 */
async function sweepStructuredSessions(
  worktreeId: string,
  deps: WorktreeTeardownDeps,
  deadline: number,
  sweeps: WorktreeSweepTracker
): Promise<number> {
  if (!deps.requirePhysicalStop && !deps.closeStructuredSessions) {
    return 0
  }
  // `deps` carries the same two host fields the PTY sweeps fence on, and a `repoId::path` id names
  // a different workspace on every host — so an unfenced list would close a live chat belonging to
  // an SSH or paired-runtime copy of the id being removed here.
  const live = listLiveStructuredSessionsForWorktree(worktreeId, deps)
  if (live.length === 0) {
    return 0
  }
  // Raced against the same sweep budget every PTY surface is bounded by, because `host.close`
  // awaits a provider round trip whose own eviction steps are each bounded well past this budget.
  //
  // Deliberately NOT fail-closed, unlike the PTY sweeps: their timeout sentinel carries the PTY
  // timeout prefix, which the desktop classifier reads as a TERMINAL failure — so a wedged session
  // close would refuse in terminal wording, and refuse identically again under the Force Delete
  // that is meant to clear it (#11960). A close that ran out of time is a session this removal
  // could not confirm closed, which is exactly what the branch below already words. Tracked so a
  // forced removal still waits out the abandoned-sweep grace before it deletes files.
  //
  // The verdict is read off `progress`, which the serial loop fills as it goes, rather than off
  // this call's result: the deadline can land mid-loop, and a fallback assembled here could only
  // guess — it named every session, including the ones already closed, and reported zero closes.
  const progress = createStructuredSweepProgress(live)
  await settleBeforeDeadline(
    sweeps.track(() =>
      closeStructuredSessionsForWorktree(progress, deadline, {
        ...(deps.runtime ? { runtime: deps.runtime } : {}),
        // The only shape of removal that can leave this workspace — and its chat tabs — in place.
        mayRefuse: Boolean(deps.requirePhysicalStop) && !deps.allowUnverifiedStop
      })
    ),
    undefined,
    deadline
  )
  const closed = progress.closed
  const unstopped = unclosedStructuredSessions(progress)
  if (unstopped.length === 0) {
    return closed
  }
  // Only a proof-requiring removal may refuse. A folder-workspace removal shares its root, so no
  // checkout disappears under the child — the harm is a session left pointing at a workspace Orca
  // has forgotten — and every one of those callers discards a rejection anyway.
  if (deps.requirePhysicalStop && !deps.allowUnverifiedStop) {
    // The prefix is what the desktop classifier matches on; without it the toast shows raw CLI
    // wording and hides the Force Delete button — the #11960 dead end this file already documents.
    throw new Error(
      `${RUNNING_AGENT_SESSION_REMOVAL_PREFIX} ${worktreeId}${UNSTOPPED_PTY_DETAIL_SEPARATOR}${describeUnclosedStructuredSessions(unstopped)}. ${WORKTREE_TEARDOWN_FORCE_HINT}`
    )
  }
  // Force is the documented escape hatch, so removal continues — but say so, because the child
  // outliving its `cwd` is the failure this sweep exists to make visible. Carries the verdict
  // verbatim, like the unstopped-PTY warn above: this line is the only record a forced removal
  // leaves, and appending "still attached" asserted the live verdict over sessions the sweep had
  // just said it could not confirm either way.
  console.warn(
    `[worktree-teardown] forcing removal of ${worktreeId}${UNSTOPPED_PTY_DETAIL_SEPARATOR}${describeUnclosedStructuredSessions(unstopped)}`
  )
  return closed
}
