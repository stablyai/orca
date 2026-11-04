import { isAutomationRunHistory } from '../../shared/automation-run-retention'
import type { AutomationRun, AutomationRunStatus } from '../../shared/automations-types'
import { compareAutomationRunsNewestFirst } from '../../shared/automation-run-cursor'
import { automationRunRecency } from '../../shared/automation-session-reuse'

export const RUN_TERMINAL_GRACE_MS = 10 * 60_000
export const RUN_TERMINALS_KEPT_PER_AUTOMATION = 3
const SWEEP_INTERVAL_MS = 60_000

export type HeadlessRunTerminalRetentionDeps = {
  listRuns: () => readonly AutomationRun[]
  /** Creation authority; delivery alone never acquires another owner's terminal. */
  ownsRunTerminal?: (run: AutomationRun, ancestors: readonly AutomationRun[]) => boolean
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
  sleepRunWorkspace: (
    run: AutomationRun,
    assertSafe: () => void,
    assertOwned: () => void
  ) => Promise<boolean>
  /** Clear terminal references while preserving status, error and output. */
  forgetRunTerminal: (run: AutomationRun, assertOwned: () => void) => Promise<void>
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

  const forget = async (run: AutomationRun, assertOwned: () => void): Promise<void> => {
    assertOwned()
    await deps.forgetRunTerminal(run, assertOwned)
    firstSeenAt.delete(run.id)
  }

  const sweepAutomation = async (
    automationId: string,
    policy: { keep: number; graceMs: number },
    expectedGeneration: number,
    readSnapshot: () => ReturnType<typeof indexRuns>
  ): Promise<number> => {
    let releasedCount = 0
    let kept = 0
    const ownedPaneKeys = new Set<string>()
    const runs = (readSnapshot().byAutomation.get(automationId) ?? [])
      .filter(
        (run): run is PanedRun =>
          Boolean(run.terminalPaneKey && run.terminalPtyId) && !STARTING.has(run.status)
      )
      .toSorted(compareRetainedRuns)
    const owns = (run: AutomationRun): boolean =>
      deps.ownsRunTerminal?.(run, readSnapshot().byResource.get(resourceKey(run)) ?? []) ?? true
    for (const run of runs) {
      if (!firstSeenAt.has(run.id)) {
        firstSeenAt.set(run.id, now())
      }
      const assertOwned = (): void => {
        const current = readSnapshot().byId.get(run.id)
        if (
          generation !== expectedGeneration ||
          !current ||
          current.workspaceId !== run.workspaceId ||
          current.status !== run.status ||
          current.terminalPaneKey !== run.terminalPaneKey ||
          current.terminalPtyId !== run.terminalPtyId ||
          !owns(current)
        ) {
          throw new Error('automation_terminal_retention_revoked')
        }
      }
      try {
        if (!deps.runTerminalAlive(run)) {
          if (generation === expectedGeneration && isAutomationRunHistory(run) && owns(run)) {
            await forget(run, assertOwned)
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
          !owns(run) ||
          !incarnation ||
          deps.terminalClientUse(run) !== 'unused' ||
          now() - (firstSeenAt.get(run.id) ?? now()) < policy.graceMs
        ) {
          continue
        }
        const shell = await deps.shellAloneAtPrompt(run)
        const assertSafe = (): void => {
          const latest = readSnapshot().latestByPane.get(run.terminalPaneKey)
          if (
            generation !== expectedGeneration ||
            !latest ||
            !owns(latest) ||
            latest.id !== run.id ||
            latest.workspaceId !== run.workspaceId ||
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
          if (await deps.sleepRunWorkspace(run, assertSafe, assertOwned)) {
            firstSeenAt.delete(run.id)
            releasedCount += 1
          }
          continue
        }
        if (await deps.closeRunTerminal(run, assertSafe)) {
          releasedCount += 1
          await forget(run, assertOwned)
        }
      } catch (error) {
        console.error('[automations] could not close a run terminal:', error)
      }
    }
    return releasedCount
  }

  const sweepOnce = async (policy: { keep: number; graceMs: number }): Promise<number> => {
    const expectedGeneration = generation
    let snapshot: ReturnType<typeof indexRuns> | undefined
    let source: readonly AutomationRun[] | undefined
    const readSnapshot = () => {
      const current = deps.listRuns()
      if (!snapshot || current !== source) {
        source = current
        snapshot = indexRuns(current)
      }
      return snapshot
    }
    let releasedCount = 0
    const retained = new Set(
      readSnapshot()
        .runs.filter((run) => run.terminalPaneKey && run.terminalPtyId)
        .map((run) => run.id)
    )
    for (const id of firstSeenAt.keys()) {
      if (!retained.has(id)) {
        firstSeenAt.delete(id)
      }
    }
    for (const automationId of readSnapshot().byAutomation.keys()) {
      releasedCount += await deps.inAutomationLane(automationId, () =>
        sweepAutomation(automationId, policy, expectedGeneration, readSnapshot)
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

function resourceKey(run: AutomationRun): string {
  return JSON.stringify([run.automationId, run.workspaceId, run.terminalPaneKey, run.terminalPtyId])
}

function indexRuns(runs: readonly AutomationRun[]) {
  const byId = new Map<string, AutomationRun>()
  const byAutomation = new Map<string, AutomationRun[]>()
  const byResource = new Map<string, AutomationRun[]>()
  const latestByPane = new Map<string, AutomationRun>()
  for (const run of runs) {
    byId.set(run.id, run)
    const automation = byAutomation.get(run.automationId) ?? []
    automation.push(run)
    byAutomation.set(run.automationId, automation)
    const key = resourceKey(run)
    const ancestors = byResource.get(key) ?? []
    ancestors.push(run)
    byResource.set(key, ancestors)
    if (run.terminalPaneKey) {
      const latest = latestByPane.get(run.terminalPaneKey)
      if (!latest || compareRetainedRuns(run, latest) < 0) {
        latestByPane.set(run.terminalPaneKey, run)
      }
    }
  }
  return { runs, byId, byAutomation, byResource, latestByPane }
}

function compareRetainedRuns(a: AutomationRun, b: AutomationRun): number {
  return automationRunRecency(b) - automationRunRecency(a) || compareAutomationRunsNewestFirst(a, b)
}
