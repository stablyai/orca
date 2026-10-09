/**
 * Closing run terminals on a headless host. The desktop closes a run's terminal when the run
 * completes; on orcad nobody does, so schedules leave a shell and a PTY per run until the host
 * runs out. A run terminal stays open for a grace period and the newest few per automation stay
 * viewable; older ones are closed. A completed run's terminal is closed as is. A failed or
 * never-finishing run's is closed only once the shell is proven alone at its prompt, since a timed
 * out agent may still be alive. A terminal a client typed into or is viewing, or one whose use
 * this host cannot tell, is never closed: as on the desktop, that terminal is the user's.
 */
import {
  isFinalAutomationRunStatus,
  type AutomationRun,
  type AutomationRunStatus
} from '../../shared/automations-types'

export const RUN_TERMINAL_GRACE_MS = 10 * 60_000
export const RUN_TERMINALS_KEPT_PER_AUTOMATION = 3
const SWEEP_INTERVAL_MS = 60_000

export type HeadlessRunTerminalRetentionDeps = {
  listRuns: () => readonly AutomationRun[]
  /**
   * Whether any client drove or is viewing the run's terminal. Like the desktop's take-over rule,
   * a used terminal is the user's now; `unknown` keeps it too.
   */
  terminalClientUse: (run: AutomationRun) => 'used' | 'unused' | 'unknown'
  /** Whether the run's pane still holds the run's own PTY; a dead or replaced one is forgotten. */
  runTerminalAlive: (run: AutomationRun) => boolean
  /** Fresh proof that only the shell runs in the run's PTY, at its prompt; false when unproven. */
  shellAloneAtPrompt: (run: AutomationRun) => Promise<boolean>
  /**
   * Closes the run's own pane, leaving any pane a user split into that tab. False, closing
   * nothing, when the pane is gone or now holds another PTY (a restart put a new one there).
   */
  closeRunTerminal: (run: AutomationRun) => Promise<boolean>
  /** Drops the closed terminal from the run, keeping its status, error and output. */
  forgetRunTerminal: (run: AutomationRun) => Promise<void>
  now?: () => number
}

/** Still starting: its agent is being launched, so its terminal is never a candidate. */
const STARTING: ReadonlySet<AutomationRunStatus> = new Set(['pending', 'dispatching'])

export function createHeadlessRunTerminalRetention(deps: HeadlessRunTerminalRetentionDeps): {
  sweep: () => Promise<void>
  /** Before an update restarts the server: no grace, no newest-N, every other rule still holds. */
  drain: () => Promise<number>
  start: () => void
  stop: () => void
} {
  const now = deps.now ?? Date.now
  // When each run terminal was first seen as a candidate; the grace runs from there.
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

  const sweepOnce = async (policy: { keep: number; graceMs: number }): Promise<number> => {
    let closedCount = 0
    const byAutomation = new Map<string, AutomationRun[]>()
    for (const run of deps.listRuns()) {
      if (!run.terminalPaneKey || STARTING.has(run.status)) {
        continue
      }
      if (!firstSeenAt.has(run.id)) {
        firstSeenAt.set(run.id, now())
      }
      byAutomation.set(run.automationId, [...(byAutomation.get(run.automationId) ?? []), run])
    }
    for (const runs of byAutomation.values()) {
      let kept = 0
      for (const run of runs.toSorted((a, b) => runRecency(b) - runRecency(a))) {
        try {
          // A terminal already gone holds no keep slot; only live ones stay viewable.
          if (!deps.runTerminalAlive(run)) {
            if (isFinalAutomationRunStatus(run.status)) {
              await forget(run)
            }
            continue
          }
          if (kept < policy.keep) {
            kept += 1
            continue
          }
          if (!(await mayClose(run, policy.graceMs))) {
            continue
          }
          if (await deps.closeRunTerminal(run)) {
            closedCount += 1
          }
          await forget(run)
        } catch (error) {
          console.error('[automations] could not close a run terminal:', error)
        }
      }
    }
    return closedCount
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
    // Waits out a periodic sweep so the two never close the same terminal twice.
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

function runRecency(run: AutomationRun): number {
  return run.dispatchedAt ?? run.startedAt ?? run.createdAt
}
