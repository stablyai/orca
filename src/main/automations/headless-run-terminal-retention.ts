import { isAutomationRunHistory } from '../../shared/automation-run-retention'
import type { AutomationRun, AutomationRunStatus } from '../../shared/automations-types'
import { automationRunRecency } from '../../shared/automation-session-reuse'

export const RUN_TERMINAL_GRACE_MS = 10 * 60_000
export const RUN_TERMINALS_KEPT_PER_AUTOMATION = 3
const SWEEP_INTERVAL_MS = 60_000

export type HeadlessRunTerminalRetentionDeps = {
  listRuns: () => readonly AutomationRun[]
  /** Used, viewed, or unknown-use terminals belong to the user and must stay open. */
  terminalClientUse: (run: AutomationRun) => 'used' | 'unused' | 'unknown'
  /** True only while the pane holds this run's PTY. */
  terminalIncarnation: (run: AutomationRun) => string | null
  runTerminalAlive: (run: AutomationRun) => boolean
  /** Current foreground/background observations veto retirement; they do not prove input consumption. */
  wholePaneClear: (run: AutomationRun, allowEmpty?: boolean) => boolean
  shellAloneAtPrompt: (run: AutomationRun) => Promise<boolean>
  /** Close only this run's pane and PTY; preserve user-created splits. */
  closeRunTerminal: (run: AutomationRun, assertSafe: () => void) => Promise<boolean>
  runOwnsWorkspace: (run: AutomationRun) => boolean
  /** Preserve the resumable tab; return false if another terminal is live or sleep fails. */
  sleepRunWorkspace: (run: AutomationRun, assertSafe: () => void) => Promise<boolean>
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
  let generation = 0

  const forget = async (run: AutomationRun): Promise<void> => {
    await deps.forgetRunTerminal(run)
    firstSeenAt.delete(run.id)
  }

  const sweepAutomation = async (
    automationId: string,
    policy: { keep: number; graceMs: number },
    expectedGeneration: number
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
          if (isAutomationRunHistory(run)) {
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
        const incarnation = deps.terminalIncarnation(run)
        if (
          !incarnation ||
          deps.terminalClientUse(run) !== 'unused' ||
          now() - (firstSeenAt.get(run.id) ?? now()) < policy.graceMs
        ) {
          continue
        }
        const shell = await deps.shellAloneAtPrompt(run)
        const assertSafe = (): void => {
          const latest = deps
            .listRuns()
            .filter((candidate) => candidate.terminalPaneKey === run.terminalPaneKey)
            .toSorted((a, b) => automationRunRecency(b) - automationRunRecency(a))[0]
          if (
            generation !== expectedGeneration ||
            !latest ||
            latest.id !== run.id ||
            latest.terminalPtyId !== run.terminalPtyId ||
            latest.status !== run.status ||
            deps.terminalClientUse(latest) !== 'unused' ||
            !deps.runTerminalAlive(latest) ||
            deps.terminalIncarnation(latest) !== incarnation ||
            !(
              (latest.status === 'completed' && deps.wholePaneClear(latest)) ||
              (shell && deps.wholePaneClear(latest, true))
            )
          ) {
            throw new Error('automation_terminal_retention_revoked')
          }
        }
        assertSafe()
        // Closing a completed run's own workspace would lose its resumable session.
        if (run.status === 'completed' && deps.runOwnsWorkspace(run)) {
          if (await deps.sleepRunWorkspace(run, assertSafe)) {
            firstSeenAt.delete(run.id)
            releasedCount += 1
          }
          continue
        }
        if (await deps.closeRunTerminal(run, assertSafe)) {
          releasedCount += 1
          await forget(run)
        }
      } catch (error) {
        console.error('[automations] could not close a run terminal:', error)
      }
    }
    return releasedCount
  }

  const sweepOnce = async (policy: { keep: number; graceMs: number }): Promise<number> => {
    const expectedGeneration = generation
    let releasedCount = 0
    const retained = new Set(
      deps
        .listRuns()
        .filter((run) => run.terminalPaneKey && run.terminalPtyId)
        .map((run) => run.id)
    )
    for (const id of firstSeenAt.keys()) {
      if (!retained.has(id)) {
        firstSeenAt.delete(id)
      }
    }
    for (const automationId of new Set(deps.listRuns().map((run) => run.automationId))) {
      releasedCount += await deps.inAutomationLane(automationId, () =>
        sweepAutomation(automationId, policy, expectedGeneration)
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
      generation += 1
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    }
  }
}

type PanedRun = AutomationRun & { terminalPaneKey: string }
