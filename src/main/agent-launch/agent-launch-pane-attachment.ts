/** Use process-local launch state; after restart, ordinary pane attachment handles recovery. */

import type { AgentLaunchPaneVerdict } from '../../shared/agent-launch-pane-verdict'
import { parsePaneKey } from '../../shared/stable-pane-id'
import type { TerminalSurfaceCloseTarget } from '../../shared/terminal-surface-close-target'

const PROCEED: AgentLaunchPaneVerdict = { kind: 'proceed' }

export type AgentLaunchPane = { worktreeId: string; paneKey: string }

type RunningLaunch = {
  pane: AgentLaunchPane
  /** Unblock attachment when the agent binds or the launch ends, whichever happens first. */
  settled: Promise<AgentLaunchPaneVerdict>
  finished: Promise<AgentLaunchPaneVerdict>
  closedByUser: boolean
}

const runningLaunchesByPane = new Map<string, RunningLaunch>()
const failedLaunchesByPane = new Map<
  string,
  { pane: AgentLaunchPane; verdict: AgentLaunchPaneVerdict }
>()

function paneKeyOf(pane: AgentLaunchPane): string {
  return JSON.stringify([pane.worktreeId, pane.paneKey])
}

export type RunningAgentLaunchPane = {
  /** Attach as soon as the agent binds, without waiting for prompt delivery. */
  agentBound(): void
  finish(verdict: AgentLaunchPaneVerdict): void
  closedByUser(): boolean
}

/** Register before tab publication so immediately mounted panes wait for the launch. */
export function trackRunningAgentLaunchPane(pane: AgentLaunchPane): RunningAgentLaunchPane {
  const key = paneKeyOf(pane)
  let resolve!: (verdict: AgentLaunchPaneVerdict) => void
  let settle!: (verdict: AgentLaunchPaneVerdict) => void
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
  failedLaunchesByPane.delete(key)
  let finished = false
  return {
    agentBound: () => settle(PROCEED),
    finish: (verdict) => {
      if (finished) {
        return
      }
      finished = true
      if (runningLaunchesByPane.get(key) === running) {
        runningLaunchesByPane.delete(key)
        if (
          !running.closedByUser &&
          (verdict.kind === 'not-started' || verdict.kind === 'unconfirmed')
        ) {
          failedLaunchesByPane.set(key, { pane, verdict })
        }
      }
      settle(verdict)
      resolve(verdict)
    },
    closedByUser: () => running.closedByUser
  }
}

/** `null` targets every pane of the workspace. */
function launchesIn<T extends { pane: AgentLaunchPane }>(
  launches: Map<string, T>,
  worktreeId: string,
  target: TerminalSurfaceCloseTarget | null
): T[] {
  return [...launches.values()].filter((launch) => {
    const pane = launch.pane.worktreeId === worktreeId ? parsePaneKey(launch.pane.paneKey) : null
    return (
      pane !== null &&
      (target === null ||
        (pane.tabId === target.tabId && (target.kind === 'tab' || pane.leafId === target.leafId)))
    )
  })
}

function runningLaunchesIn(
  worktreeId: string,
  target: TerminalSurfaceCloseTarget
): RunningLaunch[] {
  return launchesIn(runningLaunchesByPane, worktreeId, target)
}

export function markAgentLaunchesClosedByUser(
  worktreeId: string,
  target: TerminalSurfaceCloseTarget
): void {
  for (const running of runningLaunchesIn(worktreeId, target)) {
    running.closedByUser = true
  }
  forgetFailedAgentLaunches(worktreeId, target)
}

/** Forget departed panes; null targets the entire workspace. */
export function forgetFailedAgentLaunches(
  worktreeId: string,
  target: TerminalSurfaceCloseTarget | null
): void {
  for (const failed of launchesIn(failedLaunchesByPane, worktreeId, target)) {
    failedLaunchesByPane.delete(paneKeyOf(failed.pane))
  }
}

export function listFailedAgentLaunchWorktreeIds(): string[] {
  return [...failedLaunchesByPane.values()].map((failed) => failed.pane.worktreeId)
}

/** Only the owning launch may spawn into a reserved pane. */
export function isAgentLaunchRunningIn(
  worktreeId: string,
  target: TerminalSurfaceCloseTarget
): boolean {
  return runningLaunchesIn(worktreeId, target).length > 0
}

/** Live processes and persisted bindings both qualify for adoption. */
export type IsAgentLaunchPaneLive = (paneKey: string) => boolean

async function settleVerdict(
  pane: AgentLaunchPane,
  isPaneLive: IsAgentLaunchPaneLive
): Promise<AgentLaunchPaneVerdict> {
  let verdict = failedLaunchesByPane.get(paneKeyOf(pane))?.verdict ?? PROCEED
  // A retry can replace the launch in this pane while we await its verdict.
  for (
    let running = runningLaunchesByPane.get(paneKeyOf(pane));
    running;
    running = runningLaunchesByPane.get(paneKeyOf(pane))
  ) {
    if ((await running.settled).kind === 'withdrawn') {
      return { kind: 'withdrawn' }
    }
    if (isPaneLive(pane.paneKey)) {
      return PROCEED
    }
    verdict = await running.finished
    if (verdict.kind === 'withdrawn') {
      return verdict
    }
  }
  if (!isPaneLive(pane.paneKey)) {
    return verdict
  }
  failedLaunchesByPane.delete(paneKeyOf(pane))
  return PROCEED
}

/** Return null synchronously for ordinary panes so their spawn timing stays unchanged. */
export function resolveAgentLaunchPaneVerdict(
  pane: AgentLaunchPane,
  isPaneLive: IsAgentLaunchPaneLive
): Promise<AgentLaunchPaneVerdict> | null {
  const key = paneKeyOf(pane)
  return runningLaunchesByPane.has(key) || failedLaunchesByPane.has(key)
    ? settleVerdict(pane, isPaneLive)
    : null
}

export function resetAgentLaunchPanesForTests(): void {
  runningLaunchesByPane.clear()
  failedLaunchesByPane.clear()
}
