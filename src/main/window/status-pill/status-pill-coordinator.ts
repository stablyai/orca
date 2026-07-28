import type { Store } from '../../persistence'
import type { AgentHookServer } from '../../agent-hooks/server'
import type { StatusPillFocusTarget } from '../../../shared/status-pill-preload-api'
import {
  createStatusPillWindow,
  type StatusPillRuntime,
  type StatusPillWindowHandle
} from './createStatusPillWindow'
import {
  computeStatusPillAttentionTransitions,
  type StatusPillAttentionEntry,
  type StatusPillAttentionTransition
} from './status-pill-attention'
import type { AgentStatusIpcPayload } from '../../../shared/agent-status-types'

export type StatusPillCoordinatorOptions = {
  store: Store
  agentHookServer: AgentHookServer
  /** Focus the Orca main window (reopening it if needed). Called when the user
   *  clicks the pill body. */
  onFocusMainWindow: () => void
  /** Focus a specific agent pane in the main window. Called when the user
   *  clicks a row in the expanded panel. */
  onFocusPane: (target: StatusPillFocusTarget) => void
  /** Runtime, used to write agent answers from the pill. Optional so the pill
   *  can mount in tests without a live runtime; answer attempts return
   *  `send_failed` when absent. */
  runtime?: StatusPillRuntime
  /** Fired once per batch when an agent newly enters a waiting/blocked state
   *  with a live question (after cooldown). The main index turns this into a
   *  dock bounce + tray attention + OS notification. Optional so tests can
   *  exercise detection without Electron. */
  onAttentionNeeded?: (transition: StatusPillAttentionTransition) => void
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
  private readonly onFocusPane: (target: StatusPillFocusTarget) => void
  private readonly onAttentionNeeded?: (transition: StatusPillAttentionTransition) => void
  private readonly runtime?: StatusPillRuntime
  private readonly warn: (message: string, error?: unknown) => void
  private handle: StatusPillWindowHandle | null = null
  private unsubscribeSettings: (() => void) | null = null
  private unsubscribeStatus: (() => void) | null = null
  private destroyed = false
  // Why: previous snapshot + per-pane cooldown drive attention detection so a
  // pane only alerts when it *transitions* into a waiting/blocked state. Typed
  // against the minimal structural entry so it accepts both the IPC snapshot
  // and the raw hook status-change stream.
  private prevSnapshot: StatusPillAttentionEntry[] = []
  private readonly attentionCooldowns = new Map<string, number>()

  constructor(options: StatusPillCoordinatorOptions) {
    this.store = options.store
    this.agentHookServer = options.agentHookServer
    this.onFocusMainWindow = options.onFocusMainWindow
    this.onFocusPane = options.onFocusPane
    this.onAttentionNeeded = options.onAttentionNeeded
    this.runtime = options.runtime
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
    // agent-status fanout, and to drive attention detection.
    this.unsubscribeStatus = this.agentHookServer.subscribeStatusChanges((statuses) => {
      this.handle?.broadcastSnapshot()
      this.detectAttention(statuses ?? [])
    })

    // Why: sync once on construction so a profile that already had the setting
    // on (e.g. app restart with persisted state) shows the pill without
    // requiring a fresh toggle.
    this.syncWithSettings()
  }

  /** True when the pill window is currently mounted. Exposed for diagnostics. */
  isPillOpen(): boolean {
    return this.handle !== null && !this.handle.window.isDestroyed()
  }

  /** Force the pill to recompute its summary from the current snapshot. */
  refresh(): void {
    this.handle?.broadcastSnapshot()
  }

  /** Final teardown: destroys the window, detaches all listeners. Idempotent. */
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

  /** Compare the latest snapshot against the previous one and fire a single
   *  per-batch attention alert when an agent newly needs the user. */
  private detectAttention(next: StatusPillAttentionEntry[]): void {
    const now = Date.now()
    const transitions = this.onAttentionNeeded
      ? computeStatusPillAttentionTransitions(this.prevSnapshot, next, now, this.attentionCooldowns)
      : []
    // Why: always advance the previous snapshot so a pane that stays waiting
    // is treated as "already alerted" on the next tick (no repeated firing).
    this.prevSnapshot = next
    if (transitions.length === 0 || !this.onAttentionNeeded) {
      return
    }
    for (const transition of transitions) {
      this.attentionCooldowns.set(transition.paneKey, now)
    }
    const lead = transitions[0]
    if (!lead || !this.handle || this.handle.window.isDestroyed()) {
      return
    }
    // Why: nudge the pill renderer so it can run an attention animation even
    // when the user is looking at another app.
    try {
      this.handle.window.webContents.send('statusPill:attentionPulse', { paneKey: lead.paneKey })
    } catch {
      // Best-effort; webContents mid-teardown.
    }
    this.onAttentionNeeded(lead)
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
      onFocusPane: this.onFocusPane,
      runtime: this.runtime,
      // Why: read/write the pill position on UI state (same store region as
      // windowBounds) so the pill restores where the user last dragged it and
      // survives app restarts.
      getPersistedPosition: () => this.store.getUI().statusPillPosition ?? null,
      persistPosition: (position) => {
        this.store.updateUI({ statusPillPosition: position })
      },
      warn: this.warn
    })
    // Why: seed the previous snapshot with the current state so panes already
    // waiting when the pill opens don't all fire an alert at once.
    this.prevSnapshot = getSnapshot()
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
