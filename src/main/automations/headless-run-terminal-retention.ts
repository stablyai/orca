import { isAutomationRunHistory } from '../../shared/automation-run-retention'
import type { AutomationRun, AutomationRunStatus } from '../../shared/automations-types'
import type { AutomationRunsChanged } from '../persistence/scheduling-automations/automation-run-operations'
import {
  RunTerminalRetentionIndex,
  compareRetainedRuns,
  resourceKey
} from './run-terminal-retention-index'

export const RUN_TERMINAL_GRACE_MS = 10 * 60_000
export const RUN_TERMINALS_KEPT_PER_AUTOMATION = 3
const SWEEP_INTERVAL_MS = 60_000

export type HeadlessRunTerminalRetentionDeps = {
  listRuns: () => readonly AutomationRun[]
  /** Creation authority; delivery alone never acquires another owner's terminal. */
  ownsRunTerminal?: (run: AutomationRun, ancestors: Iterable<AutomationRun>) => boolean | string
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
    assertOwned: () => void,
    changed: AutomationRunsChanged
  ) => Promise<boolean>
  /** Clear terminal references while preserving status, error and output. */
  forgetRunTerminal: (
    run: AutomationRun,
    assertOwned: () => void,
    changed: AutomationRunsChanged
  ) => Promise<void>
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
  let discardSweep: (() => void) | undefined

  const forget = async (
    run: AutomationRun,
    assertOwned: () => void,
    changed: AutomationRunsChanged
  ): Promise<void> => {
    assertOwned()
    await deps.forgetRunTerminal(run, assertOwned, changed)
    firstSeenAt.delete(run.id)
  }

  const sweepAutomation = async (
    automationId: string,
    policy: { keep: number; graceMs: number },
    expectedGeneration: number,
    readSnapshot: () => RunTerminalRetentionIndex,
    changed: AutomationRunsChanged
  ): Promise<number> => {
    if (generation !== expectedGeneration) {
      return 0
    }
    let releasedCount = 0
    let kept = 0
    const ownedPaneKeys = new Set<string>()
    const snapshot = readSnapshot()
    const runs = Array.from(snapshot.byAutomation.get(automationId) ?? [], (id) =>
      snapshot.byId.get(id)!
    )
      .filter(
        (run): run is PanedRun =>
          Boolean(run.terminalPaneKey && run.terminalPtyId) && !STARTING.has(run.status)
      )
      .toSorted(compareRetainedRuns)
    const owns = (run: AutomationRun): boolean => {
      const current = readSnapshot()
      const authority = deps.ownsRunTerminal?.(run, current.ancestors(run)) ?? true
      if (typeof authority === 'string') {
        current.creator(run, authority)
      }
      return Boolean(authority)
    }
    let negativeSource: readonly AutomationRun[] | undefined
    const missingAuthority = new Set<string>()
    for (const candidate of runs) {
      if (generation !== expectedGeneration) {
        break
      }
      const run = readSnapshot().byId.get(candidate.id)
      if (!run?.terminalPaneKey || !run.terminalPtyId || STARTING.has(run.status)) {
        continue
      }
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
          const source = deps.listRuns()
          if (source !== negativeSource) {
            missingAuthority.clear()
            negativeSource = source
          }
          const key = resourceKey(run)
          if (
            generation === expectedGeneration &&
            isAutomationRunHistory(run) &&
            !missingAuthority.has(key)
          ) {
            if (owns(run)) {
              missingAuthority.clear()
              negativeSource = undefined
              await forget(run, assertOwned, changed)
            } else {
              missingAuthority.add(key)
            }
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
        missingAuthority.clear()
        negativeSource = undefined
        const shell = await deps.shellAloneAtPrompt(run)
        const assertSafe = (): void => {
          const latest = readSnapshot().latest(run.terminalPaneKey)
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
          if (await deps.sleepRunWorkspace(run, assertSafe, assertOwned, changed)) {
            firstSeenAt.delete(run.id)
            releasedCount += 1
          }
          continue
        }
        if (await deps.closeRunTerminal(run, assertSafe)) {
          releasedCount += 1
          await forget(run, assertOwned, changed)
        }
      } catch (error) {
        console.error('[automations] could not close a run terminal:', error)
      }
    }
    return releasedCount
  }

  const sweepOnce = async (policy: { keep: number; graceMs: number }): Promise<number> => {
    const expectedGeneration = generation
    let snapshot: RunTerminalRetentionIndex | undefined
    let source: readonly AutomationRun[] | undefined
    const readSnapshot = () => {
      if (generation !== expectedGeneration) {
        throw new Error('automation_terminal_retention_revoked')
      }
      const current = deps.listRuns()
      if (!snapshot || current !== source) {
        source = current
        snapshot = new RunTerminalRetentionIndex(current)
      }
      return snapshot
    }
    let active = true
    const changed: AutomationRunsChanged = (mutation) => {
      if (!active || generation !== expectedGeneration) {
        return
      }
      if (
        mutation &&
        snapshot &&
        source === mutation.before &&
        deps.listRuns() === mutation.after
      ) {
        snapshot.apply(mutation)
        source = mutation.after
      } else {
        snapshot = undefined
        source = undefined
      }
    }
    const discard = () => {
      active = false
      snapshot = undefined
      source = undefined
    }
    discardSweep = discard
    try {
      let releasedCount = 0
      const retained = new Set(
        Array.from(readSnapshot().byId.values())
          .filter((run) => run.terminalPaneKey && run.terminalPtyId)
          .map((run) => run.id)
      )
      for (const id of firstSeenAt.keys()) {
        if (!retained.has(id)) {
          firstSeenAt.delete(id)
        }
      }
      for (const automationId of Array.from(readSnapshot().byAutomation.keys())) {
        if (generation !== expectedGeneration) {
          break
        }
        releasedCount += await deps.inAutomationLane(automationId, () =>
          sweepAutomation(automationId, policy, expectedGeneration, readSnapshot, changed)
        )
      }
      return releasedCount
    } finally {
      discard()
      if (discardSweep === discard) {
        discardSweep = undefined
      }
    }
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
      discardSweep?.()
      discardSweep = undefined
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    }
  }
}

type PanedRun = AutomationRun & { terminalPaneKey: string }
