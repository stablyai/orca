import type { Store } from '../../persistence'
import type { AgentHookServer } from '../../agent-hooks/server'
import { createStatusPillWindow, type StatusPillWindowHandle } from './createStatusPillWindow'
import type { AgentStatusIpcPayload } from '../../../shared/agent-status-types'

export type StatusPillCoordinatorOptions = {
  store: Store
  agentHookServer: AgentHookServer
  /** Focus the Orca main window (reopening it if needed). Called when the user
   *  clicks the pill body. */
  onFocusMainWindow: () => void
  /** Optional logger; defaults to console.warn. */
  warn?: (message: string, error?: unknown) => void
}

/** Owns the pill window lifecycle across settings changes and agent-status
 *  events. Subscribes to both on construction; tear down with `destroy()`
 *  before app quit. */
export class StatusPillCoordinator {
  private readonly store: Store
  private readonly agentHookServer: AgentHookServer
  private readonly onFocusMainWindow: () => void
  private readonly warn: (message: string, error?: unknown) => void
  private handle: StatusPillWindowHandle | null = null
  private unsubscribeSettings: (() => void) | null = null
  private unsubscribeStatus: (() => void) | null = null
  private destroyed = false

  constructor(options: StatusPillCoordinatorOptions) {
    this.store = options.store
    this.agentHookServer = options.agentHookServer
    this.onFocusMainWindow = options.onFocusMainWindow
    this.warn = options.warn ?? defaultWarn

    // Why: react to live toggles so the user sees the pill appear/disappear
    // immediately when they flip the Settings switch (mirrors the
    // `showMenuBarIcon` precedent in src/main/index.ts).
    this.unsubscribeSettings = this.store.onSettingsChanged((updates) => {
      if ('experimentalFloatingStatusPill' in updates) {
        this.syncWithSettings()
      }
    })

    // Why: tap the multi-listener status stream (not the single-owner
    // `setListener`) so the pill coexists with the main window's existing
    // agent-status fanout.
    this.unsubscribeStatus = this.agentHookServer.subscribeStatusChanges(() => {
      this.handle?.broadcastSnapshot()
    })

    // Why: sync once on construction so a profile that already had the setting
    // on (e.g. app restart with persisted state) shows the pill without
    // requiring a fresh toggle.
    this.syncWithSettings()
  }

  /** Whether the pill window is currently mounted. Exposed for diagnostics. */
  isPillOpen(): boolean {
    return this.handle !== null && !this.handle.window.isDestroyed()
  }

  /** Force the pill to recompute its summary from the current snapshot. Used
   *  by callers that mutate agent state outside the hook server. */
  refresh(): void {
    this.handle?.broadcastSnapshot()
  }

  /** Final teardown: destroys the window, detaches all listeners. */
  destroy(): void {
    if (this.destroyed) {
      return
    }
    this.destroyed = true
    this.handle?.destroy()
    this.handle = null
    this.unsubscribeSettings?.()
    this.unsubscribeSettings = null
    this.unsubscribeStatus?.()
    this.unsubscribeStatus = null
  }

  private syncWithSettings(): void {
    if (this.destroyed) {
      return
    }
    const enabled = this.store.getSettings().experimentalFloatingStatusPill === true
    if (enabled === this.isPillOpen()) {
      return
    }
    if (enabled) {
      this.openPill()
    } else {
      this.closePill()
    }
  }

  private openPill(): void {
    if (this.handle) {
      return
    }
    const getSnapshot = (): AgentStatusIpcPayload[] => {
      // Why: filter providerSessionOnly so resume-identity refreshes don't
      // count as activity in the pill summary.
      return this.agentHookServer
        .getStatusSnapshot()
        .filter((entry) => entry.providerSessionOnly !== true)
    }
    this.handle = createStatusPillWindow({
      getSnapshot,
      onFocusMainWindow: this.onFocusMainWindow,
      warn: this.warn
    })
  }

  private closePill(): void {
    this.handle?.destroy()
    this.handle = null
  }
}

function defaultWarn(message: string, error?: unknown): void {
  if (error === undefined) {
    console.warn(message)
  } else {
    console.warn(message, error)
  }
}
