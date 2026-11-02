import type { IPtyProvider } from '../providers/pty-provider-contract'
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
  listStructuredSessionsForWorktree,
  retireStructuredSessionTabsForWorktree,
  unclosedStructuredSessions,
  type StructuredSessionInWorkspace,
  type StructuredWorktreeSweepRuntime
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

export type WorktreeTeardownRuntime = StructuredWorktreeSweepRuntime &
  Pick<OrcaRuntimeService, 'stopTerminalsForWorktree' | 'getPtyLivenessVerdict'>

export type WorktreeTeardownDeps = {
  runtime?: WorktreeTeardownRuntime
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
  /** Close structured sessions for destructive folder removals even without PTY proof. This is separate from requirePhysicalStop; reconciliation sets neither and must never close sessions. */
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

/** Sweep graph (when attached), provider prefix sessions (daemon adapter), and registry (fallback/memory attribution). Numeric fallback ids never match the provider prefix.
 * Best-effort by default; requirePhysicalStop blocks deletion without proof. Only explicit Force Delete/--force may waive proof, never ordinary dirty-prompt force (#11960). */
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
  // Start structured closure before PTYs so intentional stops are recorded; await alongside them so serial provider round trips cannot consume their budget. Structured refusal still precedes PTY verdict.
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

  // Missing headless/newly-removed graph entries mean zero runtime PTYs; neither sentinel should block removal.
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
  // Handle rejections now: sweeps can outlive this call and not every later branch observes all of them.
  for (const sweep of [runtimeSweep, providerSweep, registrySweep]) {
    void sweep.catch(() => undefined)
  }
  const structured = await structuredSweep
  const structuredStopped = structured.closed
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
      // Force still removes chat tabs and reports structured closes even when skipping the PTY verdict.
      await retireStructuredSessionTabsForWorktree(structured.retirable, deps.runtime)
      return { ...forced.stopped, ...(structuredStopped > 0 ? { structuredStopped } : {}) }
    }
    runtimeResult = { stopped: forced.stopped.runtimeStopped }
    providerStopped = forced.stopped.providerStopped
    registryStopped = forced.stopped.registryStopped
  } else {
    // Without a force waiver, fail fast: refusal leaves files untouched.
    try {
      ;[runtimeResult, providerStopped, registryStopped] = await Promise.all([
        runtimeSweep,
        providerSweep,
        registrySweep
      ])
    } catch (error) {
      // Best-effort callers may swallow teardown errors and forget metadata; retire chat tabs before rethrowing.
      if (!deps.requirePhysicalStop) {
        await retireStructuredSessionTabsForWorktree(structured.retirable, deps.runtime)
      }
      // Wrap provider wording so the desktop can offer Force Delete; preserve the original cause (#11960).
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
      // Proof-free folder removal shares its root and may ignore errors; only proof-requiring removal can refuse.
      if (deps.requirePhysicalStop && !deps.allowUnverifiedStop) {
        throw new Error(`${summary}. ${WORKTREE_TEARDOWN_FORCE_HINT}`)
      }
      // Force continues but retains live registry rows so users and later retries can still find these PTYs (#11960).
      console.warn(`[worktree-teardown] forcing removal despite unstopped PTYs — ${summary}`)
    }
  }

  // Retire tabs only after all refusal points; a refused deletion must leave the workspace's chats in place.
  await retireStructuredSessionTabsForWorktree(structured.retirable, deps.runtime)
  return {
    runtimeStopped: runtimeResult.stopped,
    providerStopped,
    registryStopped,
    ...(structuredStopped > 0 ? { structuredStopped } : {})
  }
}

type StructuredSweepOutcome = {
  closed: number
  /** Retire detached/unclosed tabs only after removal passes every refusal; structured closure precedes the PTY verdict. */
  retirable: readonly StructuredSessionInWorkspace[]
}

const NO_STRUCTURED_SWEEP: StructuredSweepOutcome = { closed: 0, retirable: [] }

/** Close this host's structured children, not merely attached leases. Proof-requiring removal refuses unconfirmed closes; folder removal shares its root and stays best-effort. Reconciliation must never close sessions. */
async function sweepStructuredSessions(
  worktreeId: string,
  deps: WorktreeTeardownDeps,
  deadline: number,
  sweeps: WorktreeSweepTracker
): Promise<StructuredSweepOutcome> {
  if (!deps.requirePhysicalStop && !deps.closeStructuredSessions) {
    return NO_STRUCTURED_SWEEP
  }
  // Fence sessions and tab retirement by host: repo/path ids repeat across local, SSH and runtime owners.
  const { members, live } = listStructuredSessionsForWorktree(worktreeId, deps)
  const liveIds = new Set(live.map((session) => session.sessionId))
  // Detached chats are absent from PTY lists but still need durable tab retirement.
  const retirable = members.filter((session) => !liveIds.has(session.sessionId))
  if (live.length === 0) {
    return { closed: 0, retirable }
  }
  // Bound serial closes by the sweep deadline without a PTY timeout sentinel, which would misclassify session failures and defeat Force Delete.
  // Track abandoned work for force grace; read incremental progress so mid-loop timeouts retain confirmed closes.
  const progress = createStructuredSweepProgress(live)
  await settleBeforeDeadline(
    sweeps.track(() =>
      closeStructuredSessionsForWorktree(progress, deadline, {
        ...(deps.runtime ? { runtime: deps.runtime } : {}),
        // Only proof-requiring, unforced removals can leave the workspace and chat tabs in place.
        mayRefuse: Boolean(deps.requirePhysicalStop) && !deps.allowUnverifiedStop
      })
    ),
    undefined,
    deadline
  )
  const closed = progress.closed
  const unstopped = unclosedStructuredSessions(progress)
  if (unstopped.length === 0) {
    return { closed, retirable }
  }
  // Folder removals share the root and ignore refusals; only proof-requiring removal can block deletion.
  if (deps.requirePhysicalStop && !deps.allowUnverifiedStop) {
    // Keep the desktop-recognized prefix so Force Delete remains available.
    throw new Error(
      `${RUNNING_AGENT_SESSION_REMOVAL_PREFIX} ${worktreeId}${UNSTOPPED_PTY_DETAIL_SEPARATOR}${describeUnclosedStructuredSessions(unstopped)}. ${WORKTREE_TEARDOWN_FORCE_HINT}`
    )
  }
  // Warn with the actual unclosed verdict; do not claim unverifiable children are still attached.
  console.warn(
    `[worktree-teardown] forcing removal of ${worktreeId}${UNSTOPPED_PTY_DETAIL_SEPARATOR}${describeUnclosedStructuredSessions(unstopped)}`
  )
  // Force/best-effort removal forgets the workspace even if close is unproven; retire those tabs with detached members.
  return { closed, retirable: [...retirable, ...unstopped] }
}
