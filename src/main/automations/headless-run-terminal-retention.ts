import type { AutomationService } from './service'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { runOwnHandle } from './headless-automation-agent-launch'
import {
  isFinalAutomationRunStatus,
  type AutomationRun,
  type AutomationRunStatus
} from '../../shared/automations-types'
import { automationRunRecency } from '../../shared/automation-session-reuse'

export const RUN_TERMINAL_GRACE_MS = 10 * 60_000
export const RUN_TERMINALS_KEPT_PER_AUTOMATION = 3
const SWEEP_INTERVAL_MS = 60_000

export type HeadlessRunTerminalRetentionDeps = {
  listRuns: () => readonly AutomationRun[]
  /** Used, viewed, or unknown-use terminals belong to the user and must stay open. */
  terminalClientUse: (run: AutomationRun) => 'used' | 'unused' | 'unknown'
  /** True only while the pane holds this run's PTY. */
  runTerminalAlive: (run: AutomationRun) => boolean
  /** Require fresh proof that only an idle shell remains in the PTY. */
  shellAloneAtPrompt: (run: AutomationRun) => Promise<boolean>
  /** Close only this run's pane and PTY; preserve user-created splits. */
  closeRunTerminal: (run: AutomationRun) => Promise<boolean>
  runOwnsWorkspace: (run: AutomationRun) => boolean
  /** Preserve the resumable tab; return false if another terminal is live or sleep fails. */
  sleepRunWorkspace: (run: AutomationRun) => Promise<boolean>
  /** Clear terminal references while preserving status, error and output. */
  forgetRunTerminal: (run: AutomationRun) => Promise<void>
  /** Serialize retention with dispatch to protect reused panes. */
  inAutomationLane: <T>(automationId: string, operation: () => Promise<T>) => Promise<T>
  now?: () => number
}

const STARTING: ReadonlySet<AutomationRunStatus> = new Set(['pending', 'dispatching'])

export function createHeadlessRunTerminalRetention(deps: HeadlessRunTerminalRetentionDeps): {
  sweep: () => Promise<void>
  /** Release terminals before an update, bypassing grace and newest-run retention. */
  drain: () => Promise<number>
  start: () => void
  stop: () => void
} {
  const now = deps.now ?? Date.now
  // Grace starts when the terminal first becomes a candidate.
  const firstSeenAt = new Map<string, number>()
  let timer: ReturnType<typeof setInterval> | null = null
  let sweeping: Promise<void> | null = null

  const forget = async (run: AutomationRun): Promise<void> => {
    await deps.forgetRunTerminal(run)
    firstSeenAt.delete(run.id)
  }

  const mayClose = async (run: AutomationRun, graceMs: number): Promise<boolean> => {
    if (now() - (firstSeenAt.get(run.id) ?? now()) < graceMs) {
      return false
    }
    if (deps.terminalClientUse(run) !== 'unused') {
      return false
    }
    return run.status === 'completed' || (await deps.shellAloneAtPrompt(run))
  }

  const sweepAutomation = async (
    automationId: string,
    policy: { keep: number; graceMs: number }
  ): Promise<number> => {
    let releasedCount = 0
    let kept = 0
    const ownedPaneKeys = new Set<string>()
    const runs = deps
      .listRuns()
      .filter(
        (run): run is PanedRun =>
          run.automationId === automationId &&
          Boolean(run.terminalPaneKey) &&
          // Slept panes must remain resumable after their PTY is released.
          Boolean(run.terminalPtyId) &&
          !STARTING.has(run.status)
      )
      .toSorted((a, b) => automationRunRecency(b) - automationRunRecency(a))
    for (const run of runs) {
      if (!firstSeenAt.has(run.id)) {
        firstSeenAt.set(run.id, now())
      }
      try {
        if (!deps.runTerminalAlive(run)) {
          if (isFinalAutomationRunStatus(run.status)) {
            await forget(run)
          }
          continue
        }
        // The newest run controls a reused pane; older runs retain their links until it closes.
        if (ownedPaneKeys.has(run.terminalPaneKey)) {
          continue
        }
        ownedPaneKeys.add(run.terminalPaneKey)
        if (kept < policy.keep) {
          kept += 1
          continue
        }
        if (!(await mayClose(run, policy.graceMs))) {
          continue
        }
        // Closing a completed run's own workspace would lose its resumable session.
        if (run.status === 'completed' && deps.runOwnsWorkspace(run)) {
          if (await deps.sleepRunWorkspace(run)) {
            firstSeenAt.delete(run.id)
            releasedCount += 1
          }
          continue
        }
        if (await deps.closeRunTerminal(run)) {
          releasedCount += 1
        }
        await forget(run)
      } catch (error) {
        console.error('[automations] could not close a run terminal:', error)
      }
    }
    return releasedCount
  }

  const sweepOnce = async (policy: { keep: number; graceMs: number }): Promise<number> => {
    let releasedCount = 0
    for (const automationId of new Set(deps.listRuns().map((run) => run.automationId))) {
      releasedCount += await deps.inAutomationLane(automationId, () =>
        sweepAutomation(automationId, policy)
      )
    }
    return releasedCount
  }

  const sweep = (): Promise<void> => {
    sweeping ??= sweepOnce({
      keep: RUN_TERMINALS_KEPT_PER_AUTOMATION,
      graceMs: RUN_TERMINAL_GRACE_MS
    })
      .then(() => {})
      .finally(() => {
        sweeping = null
      })
    return sweeping
  }

  const drain = async (): Promise<number> => {
    // Avoid closing a terminal twice during an active sweep.
    await sweeping?.catch(() => {})
    return sweepOnce({ keep: 0, graceMs: 0 })
  }

  return {
    sweep,
    drain,
    start: () => {
      timer ??= setInterval(() => void sweep(), SWEEP_INTERVAL_MS)
      timer.unref?.()
    },
    stop: () => {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    }
  }
}

type PanedRun = AutomationRun & { terminalPaneKey: string }

export function bindHeadlessRunTerminalRetention(
  service: AutomationService,
  store: Store,
  runtime: OrcaRuntimeService
): void {
  const retention = createHeadlessRunTerminalRetention({
    listRuns: () => store.listAutomationRuns(),
    terminalClientUse: (run) =>
      run.terminalPtyId ? runtime.readTerminalClientUse(run.terminalPtyId) : 'unknown',
    runTerminalAlive: (run) => runOwnHandle(runtime, run) !== null,
    shellAloneAtPrompt: (run) =>
      run.terminalPtyId
        ? runtime.confirmTerminalShellAlone(run.terminalPtyId)
        : Promise.resolve(false),
    closeRunTerminal: async (run) => {
      const handle = runOwnHandle(runtime, run)
      if (!handle) {
        return false
      }
      // Preserve user-created splits in the same tab.
      await runtime.closeTerminal(handle)
      return true
    },
    // Shared workspaces must close run panes rather than accumulate sleeping tabs.
    runOwnsWorkspace: (run) => {
      const provenance = run.workspaceId
        ? store.getWorktreeMeta(run.workspaceId)?.automationProvenance
        : undefined
      // Why: a client-origin label names another owner's run, never one of this host's.
      return provenance?.origin !== 'client' && provenance?.automationRunId === run.id
    },
    sleepRunWorkspace: async (run) => {
      const ptyId = run.terminalPtyId
      if (!run.workspaceId || !ptyId) {
        return false
      }
      try {
        // Sleep only this PTY, preserving other live terminals and the agent resume state.
        const sleep = await runtime.sleepTerminalsForWorktree(`id:${run.workspaceId}`, {
          soleLivePtyId: ptyId
        })
        // A retry may find no live PTYs if an earlier sleep stopped the process before failing.
        const slept =
          sleep.livePtyIds.length === 0 ||
          (sleep.stoppedPtyIds.includes(ptyId) && !sleep.remainingLivePtyIds?.includes(ptyId))
        if (!slept) {
          return false
        }
      } catch (error) {
        console.error('[automations] could not sleep a run workspace:', error)
        return false
      }
      // Preserve tab and pane keys for resuming the slept agent.
      await service.markDispatchResult({ runId: run.id, status: run.status, terminalPtyId: null })
      return true
    },
    inAutomationLane: (automationId, operation) =>
      service.runInAutomationLane(automationId, operation),
    forgetRunTerminal: async (run) => {
      // An idle shell proves a dispatched run exited without a completion result.
      const unfinished = run.status === 'dispatched'
      await service.markDispatchResult({
        runId: run.id,
        status: unfinished ? 'dispatch_failed' : run.status,
        error: unfinished
          ? (run.error ?? 'The agent exited without reporting completion.')
          : run.error,
        terminalSessionId: null,
        terminalPaneKey: null,
        terminalPtyId: null
      })
    }
  })
  service.releaseFinishedRunTerminals = () => retention.drain()
  const start = service.start.bind(service)
  const stop = service.stop.bind(service)
  service.start = () => {
    start()
    retention.start()
  }
  service.stop = () => {
    retention.stop()
    stop()
  }
}
