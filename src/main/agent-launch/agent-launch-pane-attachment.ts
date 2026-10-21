/**
 * What a pane may do when an `agent.launch` showed it before its agent existed.
 *
 * Derived on every spawn, from this process alone: a launch running here for the pane, or the
 * failure one left it, says how it ended, and whether a process holds the pane says the rest. With
 * neither (after a restart) the pane is an ordinary pane: its spawn reattaches a live process,
 * starts a fresh shell for an exited or absent one, or shows the terminal host's own unavailable
 * state, exactly as any tab does. The launch record is never read for it. A user's close of its tab
 * or pane, committed to main, stops a running launch and forgets a failed one.
 */

import type { AgentLaunchPaneVerdict } from '../../shared/agent-launch-pane-verdict'
import { parsePaneKey } from '../../shared/stable-pane-id'
import type { TerminalSurfaceCloseTarget } from '../../shared/terminal-surface-close-target'

const PROCEED: AgentLaunchPaneVerdict = { kind: 'proceed' }

/** A terminal pane a launch laid out before its process existed. */
export type AgentLaunchPane = { worktreeId: string; paneKey: string }

type RunningLaunch = {
  pane: AgentLaunchPane
  /** The launch's agent holds the pane (`proceed`), or the launch is over: whichever comes first. */
  settled: Promise<AgentLaunchPaneVerdict>
  /** What the launch left for the pane once over, if no process holds it. */
  finished: Promise<AgentLaunchPaneVerdict>
  /** The user closed the launch's tab or pane while it ran; set by main's commit of that close. */
  closedByUser: boolean
}

const runningLaunchesByPane = new Map<string, RunningLaunch>()
/** What a launch that failed, or whose outcome is unknown, left its pane, until a process holds it. */
const failedLaunchesByPane = new Map<
  string,
  { pane: AgentLaunchPane; verdict: AgentLaunchPaneVerdict }
>()

function paneKeyOf(pane: AgentLaunchPane): string {
  return JSON.stringify([pane.worktreeId, pane.paneKey])
}

export type RunningAgentLaunchPane = {
  /** The launch's agent runs in the pane: a waiting spawn attaches now, not once the prompt lands. */
  agentBound(): void
  /** The launch is over. `verdict` is what an unspawned pane does: `withdrawn` when the host takes
   *  the tab back, `not-started` when the launch failed, else `proceed`. */
  finish(verdict: AgentLaunchPaneVerdict): void
  /** The user closed this launch's tab or pane: the launch must not run, or must stop. */
  closedByUser(): boolean
}

/** Registered before the window hears of the tab, so a pane that mounts at once already waits. */
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
        // A pane the user closed meanwhile is gone: nothing is left for its failure to answer.
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

/** The user closed a tab, or one pane of it: every launch still running there stops. */
export function markAgentLaunchesClosedByUser(
  worktreeId: string,
  target: TerminalSurfaceCloseTarget
): void {
  for (const running of runningLaunchesIn(worktreeId, target)) {
    running.closedByUser = true
  }
  forgetFailedAgentLaunches(worktreeId, target)
}

/** The pane left its address (closed, moved to another tab, or its workspace removed): a failure
 *  kept for it has no pane left to answer. `null` forgets the whole workspace's. */
export function forgetFailedAgentLaunches(
  worktreeId: string,
  target: TerminalSurfaceCloseTarget | null
): void {
  for (const failed of launchesIn(failedLaunchesByPane, worktreeId, target)) {
    failedLaunchesByPane.delete(paneKeyOf(failed.pane))
  }
}

/** Workspaces still holding a failed launch, for a project removal that has no other list. */
export function listFailedAgentLaunchWorktreeIds(): string[] {
  return [...failedLaunchesByPane.values()].map((failed) => failed.pane.worktreeId)
}

/** A launch still owns this pane: only its own spawn may put a process there. */
export function isAgentLaunchRunningIn(
  worktreeId: string,
  target: TerminalSurfaceCloseTarget
): boolean {
  return runningLaunchesIn(worktreeId, target).length > 0
}

/** A process holds the pane, live or by its persisted binding: the spawn adopts it. */
export type IsAgentLaunchPaneLive = (paneKey: string) => boolean

async function settleVerdict(
  pane: AgentLaunchPane,
  isPaneLive: IsAgentLaunchPaneLive
): Promise<AgentLaunchPaneVerdict> {
  let verdict = failedLaunchesByPane.get(paneKeyOf(pane))?.verdict ?? PROCEED
  // A retry can start another launch into the same pane once the first is over.
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
  // A process holds the pane now: it is an ordinary pane again.
  failedLaunchesByPane.delete(paneKeyOf(pane))
  return PROCEED
}

/**
 * Null when no launch runs for the pane, so its spawn keeps every other pane's timing and reads
 * nothing. Otherwise the verdict, once the running launch binds its agent or ends.
 */
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
