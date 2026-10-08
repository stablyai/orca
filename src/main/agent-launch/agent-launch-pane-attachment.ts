/**
 * What a pane may do when an `agent.launch` showed it before its agent existed.
 *
 * Derived on every spawn. While the launch's fate is open, the launch record (the operation ledger)
 * names the launch that owns the pane and how it ended; the runtime, and the pane's persisted
 * binding, say whether a process holds it. Once the fate is final for the pane, the tab itself keeps
 * it (`agentLaunchPane.outcome`) for the tab's life, so the pane no longer reads the record. The one
 * in-memory fact is a launch still running in this process, which dies with that launch. Its pane
 * attaches as soon as its agent runs; a user's close of its tab or pane, committed to main, stops it.
 */

import {
  listAgentSessionOperationRowsOwningPane,
  type AgentSessionOperationOwnedPane,
  type AgentSessionOperationRow
} from '../../shared/agent-session-operation-ledger'
import { isAgentLaunchResult } from '../../shared/agent-launch-intent'
import type {
  AgentLaunchPaneOutcome,
  AgentLaunchPaneVerdict
} from '../../shared/agent-launch-pane-verdict'
import { parsePaneKey } from '../../shared/stable-pane-id'
import type { TerminalSurfaceCloseTarget } from '../../shared/terminal-surface-close-target'

type RunningLaunch = {
  pane: AgentSessionOperationOwnedPane
  /** The launch's agent holds the pane, or the launch is over: whichever comes first. */
  settled: Promise<{ tabTakenBack: boolean }>
  finished: Promise<{ tabTakenBack: boolean }>
  /** The user closed the launch's tab or pane while it ran; set by main's commit of that close. */
  closedByUser: boolean
}

const runningLaunchesByPane = new Map<string, RunningLaunch>()

function paneKeyOf(pane: AgentSessionOperationOwnedPane): string {
  return JSON.stringify([pane.worktreeId, pane.paneKey])
}

export type RunningAgentLaunchPane = {
  /** The launch's agent runs in the pane: a waiting spawn attaches now, not once the prompt lands. */
  agentBound(): void
  /** The launch is over; its record says how. `tabTakenBack`: the host is closing the tab. */
  finish(outcome: { tabTakenBack: boolean }): void
  /** The user closed this launch's tab or pane: the launch must not run, or must stop. */
  closedByUser(): boolean
}

/** Registered before the window hears of the tab, so a pane that mounts at once already waits. */
export function trackRunningAgentLaunchPane(
  pane: AgentSessionOperationOwnedPane
): RunningAgentLaunchPane {
  const key = paneKeyOf(pane)
  let resolve!: (outcome: { tabTakenBack: boolean }) => void
  let settle!: (outcome: { tabTakenBack: boolean }) => void
  const running: RunningLaunch = {
    pane,
    settled: new Promise((done) => {
      settle = done
    }),
    finished: new Promise((done) => {
      resolve = done
    }),
    closedByUser: false
  }
  runningLaunchesByPane.set(key, running)
  let finished = false
  return {
    agentBound: () => settle({ tabTakenBack: false }),
    finish: (outcome) => {
      if (finished) {
        return
      }
      finished = true
      if (runningLaunchesByPane.get(key) === running) {
        runningLaunchesByPane.delete(key)
      }
      settle(outcome)
      resolve(outcome)
    },
    closedByUser: () => running.closedByUser
  }
}

function runningLaunchesIn(
  worktreeId: string,
  target: TerminalSurfaceCloseTarget
): RunningLaunch[] {
  return [...runningLaunchesByPane.values()].filter((running) => {
    const pane = running.pane.worktreeId === worktreeId ? parsePaneKey(running.pane.paneKey) : null
    return pane?.tabId === target.tabId && (target.kind === 'tab' || pane.leafId === target.leafId)
  })
}

/** The user closed a tab, or one pane of it: every launch still running there stops. */
export function markAgentLaunchesClosedByUser(
  worktreeId: string,
  target: TerminalSurfaceCloseTarget
): void {
  for (const running of runningLaunchesIn(worktreeId, target)) {
    running.closedByUser = true
  }
}

/** A launch still owns this pane: only its own spawn may put a process there. */
export function isAgentLaunchRunningIn(
  worktreeId: string,
  target: TerminalSurfaceCloseTarget
): boolean {
  return runningLaunchesIn(worktreeId, target).length > 0
}

function launchRanInPane(row: AgentSessionOperationRow, paneKey: string): boolean {
  if (row.outcome.status !== 'succeeded' || !isAgentLaunchResult(row.outcome.launch)) {
    return false
  }
  const { outcome } = row.outcome.launch
  return outcome.kind === 'terminal' && outcome.paneKey === paneKey
}

/** Reading launch bookkeeping must leave the launch or spawn as it was, never stop it. */
export function readLaunchBookkeepingOr<T>(read: () => T, fallback: T): T {
  try {
    return read()
  } catch {
    return fallback
  }
}

/** The pane's fate as the record tells it. Exported for the record-only cases a test pins. */
export function agentLaunchPaneVerdictFromRecord(
  owning: readonly AgentSessionOperationRow[],
  paneKey: string
): AgentLaunchPaneVerdict {
  if (owning.length === 0 || owning.some((row) => launchRanInPane(row, paneKey))) {
    // Nothing owns it, or an agent ran here and is gone: the pane is an ordinary terminal again.
    return { kind: 'proceed' }
  }
  const latest = owning.reduce((a, b) => (b.recordedAt > a.recordedAt ? b : a))
  switch (latest.outcome.status) {
    case 'failed':
      return { kind: 'not-started', code: latest.outcome.code }
    case 'succeeded':
      // A chat, or another pane: nothing ran here.
      return { kind: 'withdrawn' }
    case 'unknown':
    case 'pending':
      return { kind: 'unconfirmed' }
  }
}

export type AgentLaunchPaneEvidence = {
  /** A process holds the pane, live or by its persisted binding: the spawn adopts it, whatever the
   *  record says. */
  isPaneLive(paneKey: string): boolean
  /** The record's rows owning the pane when the store is already open; null when it is not. */
  openedRows(
    pane: AgentSessionOperationOwnedPane,
    now: number
  ): Iterable<AgentSessionOperationRow> | null
  /** What the pane's tab keeps about its launch: null when no launch laid it out, no outcome while
   *  the fate is open, the outcome once it is final. */
  launchPaneOnTab(): { outcome?: AgentLaunchPaneOutcome } | null
  openRows(
    pane: AgentSessionOperationOwnedPane,
    now: number
  ): Promise<Iterable<AgentSessionOperationRow>>
  now(): number
}

async function settleVerdict(
  pane: AgentSessionOperationOwnedPane,
  evidence: AgentLaunchPaneEvidence
): Promise<AgentLaunchPaneVerdict> {
  let waitedForLaunch = false
  for (;;) {
    const running = runningLaunchesByPane.get(paneKeyOf(pane))
    if (!running) {
      break
    }
    waitedForLaunch = true
    if ((await running.settled).tabTakenBack) {
      return { kind: 'withdrawn' }
    }
    if (evidence.isPaneLive(pane.paneKey)) {
      return { kind: 'proceed' }
    }
    if ((await running.finished).tabTakenBack) {
      return { kind: 'withdrawn' }
    }
  }
  if (evidence.isPaneLive(pane.paneKey)) {
    return { kind: 'proceed' }
  }
  // A launch that just settled here wrote the record; the tab's saved outcome may be an earlier
  // launch's, not yet replaced on disk.
  const final = waitedForLaunch ? undefined : evidence.launchPaneOnTab()?.outcome
  if (final) {
    return final
  }
  // Bookkeeping never gates the user: a record that cannot be read leaves an ordinary terminal.
  const rows =
    evidence.openedRows(pane, evidence.now()) ??
    (await evidence.openRows(pane, evidence.now()).catch(() => null))
  return rows
    ? agentLaunchPaneVerdictFromRecord(
        listAgentSessionOperationRowsOwningPane(rows, pane, evidence.now()),
        pane.paneKey
      )
    : { kind: 'proceed' }
}

/**
 * Null when nothing can own the pane — no launch running for it, its tab keeping nothing about a
 * launch, and no record row naming it — so every other spawn keeps its timing and reads nothing.
 * Otherwise the verdict, once any running launch is over.
 */
export function resolveAgentLaunchPaneVerdict(
  pane: AgentSessionOperationOwnedPane,
  evidence: AgentLaunchPaneEvidence
): Promise<AgentLaunchPaneVerdict> | null {
  if (!runningLaunchesByPane.has(paneKeyOf(pane)) && evidence.launchPaneOnTab() === null) {
    const rows = evidence.openedRows(pane, evidence.now())
    if (!rows || listAgentSessionOperationRowsOwningPane(rows, pane, evidence.now()).length === 0) {
      return null
    }
  }
  return settleVerdict(pane, evidence)
}

export function resetAgentLaunchPanesForTests(): void {
  runningLaunchesByPane.clear()
}
