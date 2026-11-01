// Share one main-owned restored-pane start across CLI, mobile and orchestration triggers; resume only from this workspace's stored terminal/agent.

import { isPtyIdMintedForAnotherWorkspace } from './foreign-pane-bindings'
import type { RuntimeMobileSessionCreateTerminalResult as CreatedTerminal } from '../../../../shared/runtime-session-contracts'
import { makePaneKey } from '../../../../shared/stable-pane-id'

export type StartedPty = Pick<CreatedTerminal, 'startupCwdFallback'> & { id: string }
export type RestoredPane = { worktreeId: string; tabId: string; leafId: string }

export type RestoredPaneStartPlan = {
  /** The terminal it restores from, kept so the service restores its screen or holds it. */
  sessionId?: string
}

/** Who asked, which the start keeps: an automatic probe is refused for a slept worktree. */
export type RestoredPaneTrigger = {
  automatic?: boolean
  /** A user's own tab open or Start; without it a stopped WSL distro holds the start. */
  wslUserAct?: true
  targetsHost?: boolean
  targetGroupId?: string
}

export type RestoredPaneStartPorts = {
  /** The pane's stored terminal, or null for a pane main no longer holds. */
  boundPtyId: (pane: RestoredPane) => string | null | undefined
  isLive: (ptyId: string) => boolean
  /** Shows the pane starting, before any await, so no view starts it too. */
  starting?: (pane: RestoredPane) => void
  /** Shows a start that failed, with its reason; the pane keeps what it restores from. */
  failed?: (pane: RestoredPane, error: unknown) => void
  /** Starts the pane in place, resuming its recorded agent; resolves to the terminal bound to it. */
  start: (
    pane: RestoredPane,
    plan: RestoredPaneStartPlan,
    trigger: RestoredPaneTrigger
  ) => Promise<StartedPty>
}

/** A restored pane restores from its own stored terminal, never another workspace's. */
export function restoredPaneStartPlan(
  pane: RestoredPane,
  boundPtyId: string | null | undefined
): RestoredPaneStartPlan {
  return boundPtyId && !isPtyIdMintedForAnotherWorkspace(boundPtyId, pane.worktreeId)
    ? { sessionId: boundPtyId }
    : {}
}

export class RestoredPaneStarter {
  private readonly inFlight = new Map<string, Promise<StartedPty | null>>()
  /** Each pane's last started terminal: its bind write can land after the start resolves. */
  private readonly started = new Map<string, StartedPty>()

  constructor(private readonly ports: RestoredPaneStartPorts) {}

  /** Share concurrent starts; null when main no longer holds the pane. A competing starter's terminal still satisfies every caller. */
  ensureStarted(pane: RestoredPane, trigger: RestoredPaneTrigger = {}): Promise<StartedPty | null> {
    const key = makePaneKey(pane.tabId, pane.leafId)
    const running = this.inFlight.get(key)
    if (running) {
      return running
    }
    const bound = this.ports.boundPtyId(pane)
    if (bound === null) {
      this.started.delete(key)
      return Promise.resolve(null)
    }
    if (this.isOwnLive(pane, bound)) {
      this.started.delete(key)
      return Promise.resolve({ id: bound })
    }
    const started = this.started.get(key)
    // Why: until the started terminal's binding is written, the stored layout still names the old one.
    if (started && this.ports.isLive(started.id)) {
      return Promise.resolve(started)
    }
    this.started.delete(key)
    this.ports.starting?.(pane)
    const start = this.ports
      .start(pane, restoredPaneStartPlan(pane, bound), trigger)
      .then((pty) => {
        this.started.set(key, pty)
        return pty
      })
      .catch((error: unknown) => {
        const winner = this.ports.boundPtyId(pane)
        if (this.isOwnLive(pane, winner)) {
          return { id: winner }
        }
        this.ports.failed?.(pane, error)
        throw error
      })
      .finally(() => {
        if (this.inFlight.get(key) === start) {
          this.inFlight.delete(key)
        }
      })
    this.inFlight.set(key, start)
    return start
  }

  /** A stopped terminal is no pane's start any more, so a restart into its pane starts afresh. */
  forget(ptyId: string): void {
    for (const [key, started] of this.started) {
      if (started.id === ptyId) {
        this.started.delete(key)
      }
    }
  }

  // A live terminal another workspace owns is never this pane's: it starts fresh instead.
  private isOwnLive(pane: RestoredPane, ptyId: string | null | undefined): ptyId is string {
    return (
      !!ptyId &&
      !isPtyIdMintedForAnotherWorkspace(ptyId, pane.worktreeId) &&
      this.ports.isLive(ptyId)
    )
  }
}
