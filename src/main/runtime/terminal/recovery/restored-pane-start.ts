// Layout-owner build: main's one start of a restored pane that has no live terminal, for every
// trigger that is not a desktop window's own restore (a client's first view, a CLI or
// orchestration send, wait, read or wake). Restores from the pane's stored terminal when this
// workspace owns it; the start port resumes the agent the host recorded for the pane.

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
  targetsHost?: boolean
  targetGroupId?: string
}

export type RestoredPaneStartPorts = {
  /** The pane's stored terminal, or null for a pane main no longer holds. */
  boundPtyId: (pane: RestoredPane) => string | null | undefined
  isLive: (ptyId: string) => boolean
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

  constructor(private readonly ports: RestoredPaneStartPorts) {}

  /**
   * The pane's live terminal, started once if it has none: concurrent triggers share one start.
   * Null for a pane main no longer holds. A start another starter won still resolves to its
   * terminal, so every caller ends bound to the same one.
   */
  ensureStarted(pane: RestoredPane, trigger: RestoredPaneTrigger = {}): Promise<StartedPty | null> {
    const key = makePaneKey(pane.tabId, pane.leafId)
    const running = this.inFlight.get(key)
    if (running) {
      return running
    }
    const bound = this.ports.boundPtyId(pane)
    if (bound === null) {
      return Promise.resolve(null)
    }
    if (this.isOwnLive(pane, bound)) {
      return Promise.resolve({ id: bound })
    }
    const start = this.ports
      .start(pane, restoredPaneStartPlan(pane, bound), trigger)
      .catch((error: unknown) => {
        const winner = this.ports.boundPtyId(pane)
        if (this.isOwnLive(pane, winner)) {
          return { id: winner }
        }
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

  // A live terminal another workspace owns is never this pane's: it starts fresh instead.
  private isOwnLive(pane: RestoredPane, ptyId: string | null | undefined): ptyId is string {
    return (
      !!ptyId &&
      !isPtyIdMintedForAnotherWorkspace(ptyId, pane.worktreeId) &&
      this.ports.isLive(ptyId)
    )
  }
}
