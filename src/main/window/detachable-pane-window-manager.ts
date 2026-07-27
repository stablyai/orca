import { BrowserWindow, nativeTheme, type WebContents } from 'electron'
import { join } from 'node:path'
import type { Store } from '../persistence'
import type { DetachedTerminalTabSeed } from '../../shared/types'
import {
  POPOUT_DEFAULT_HEIGHT,
  POPOUT_DEFAULT_WIDTH,
  POPOUT_MIN_HEIGHT,
  POPOUT_MIN_WIDTH,
  installPopoutBoundsPersistence,
  installPopoutWindowSecurity,
  loadPopoutHtml,
  resolveRestoredPopoutBounds,
  showPopoutWhenReady
} from './popout-window-chrome'
import {
  DetachablePaneWindowLifecycle,
  InvalidDetachablePaneWindowTransitionError,
  canTransitionDetachablePaneWindow,
  type DetachablePaneWindowState
} from './detachable-pane-window'

type PaneEntry = {
  lifecycle: DetachablePaneWindowLifecycle
  window: BrowserWindow | null
  // Set at detach time, before the window loads, so the popout's seed fetch
  // can never race it. Survives parking (native close keeps the entry) so
  // reintegration can still hand the tab back.
  seed: DetachedTerminalTabSeed | null
}

/**
 * Manages per-pane-id BrowserWindow lifecycle backed by
 * {@link DetachablePaneWindowLifecycle} state machines. Pane windows share the
 * chrome in `popout-window-chrome.ts` with the dashboard pop-out, but with
 * per-pane partition and bounds storage so multiple panes can detach
 * concurrently.
 */
export class DetachablePaneWindowManager {
  readonly #panes = new Map<string, PaneEntry>()
  readonly #parkedListeners = new Set<(paneId: string) => void>()

  /** Subscribe to native-close (park) events; returns an unsubscribe fn. */
  onPaneParked(listener: (paneId: string) => void): () => void {
    this.#parkedListeners.add(listener)
    return () => this.#parkedListeners.delete(listener)
  }

  getPaneState(paneId: string): DetachablePaneWindowState | null {
    return this.#panes.get(paneId)?.lifecycle.state ?? null
  }

  getPaneWindow(paneId: string): BrowserWindow | null {
    const entry = this.#panes.get(paneId)
    if (!entry?.window || entry.window.isDestroyed()) {
      return null
    }
    return entry.window
  }

  // Lets a detached pane's own popout renderer call pane IPC for itself
  // without being promoted to the single global trusted-UI-renderer.
  isPaneWindowSender(paneId: string, sender: WebContents): boolean {
    const window = this.getPaneWindow(paneId)
    return window != null && !window.isDestroyed() && window.webContents.id === sender.id
  }

  getPaneSeed(paneId: string): DetachedTerminalTabSeed | null {
    return this.#panes.get(paneId)?.seed ?? null
  }

  // ---------------------------------------------------------------------------
  // Detach
  // ---------------------------------------------------------------------------

  /**
   * Pop a pane out into its own OS window. Idempotent — if the pane is already
   * detached, returns the existing window. The seed is stored before the
   * window is created, so the popout's fetch always finds it.
   *
   * @throws {InvalidDetachablePaneWindowTransitionError} when the pane is not
   *   in a state that allows detachment (parked must be reintegrated first).
   */
  detachPane(paneId: string, store: Store | null, seed?: DetachedTerminalTabSeed): BrowserWindow {
    let entry = this.#panes.get(paneId)

    if (entry) {
      const { lifecycle, window } = entry
      if (lifecycle.state === 'detached') {
        const existing = window
        if (existing && !existing.isDestroyed()) {
          if (existing.isMinimized()) {
            existing.restore()
          }
          existing.focus()
          return existing
        }
      } else if (!canTransitionDetachablePaneWindow(lifecycle.state, 'transferring')) {
        throw new InvalidDetachablePaneWindowTransitionError(lifecycle.state, 'transferring')
      }
    }

    const wasNewEntry = !entry
    if (!entry) {
      entry = { lifecycle: new DetachablePaneWindowLifecycle('attached'), window: null, seed: null }
      this.#panes.set(paneId, entry)
    }

    if (entry.lifecycle.state !== 'detached') {
      entry.lifecycle.transition('transferring')
    }

    if (seed) {
      entry.seed = seed
    }

    // Why: if BrowserWindow construction throws, the entry must not be left
    // stuck in 'transferring' — that state only accepts 'attached'/'detached'
    // next, so an un-rolled-back entry would permanently reject every future
    // detachPane() call for this paneId (see Codex adversarial review).
    let window: BrowserWindow
    try {
      window = this.#createPaneWindow(paneId, store)
    } catch (err) {
      if (wasNewEntry) {
        this.#panes.delete(paneId)
      } else if (entry.lifecycle.state === 'transferring') {
        entry.lifecycle.transition('attached')
      }
      throw err
    }
    entry.window = window

    if (entry.lifecycle.state === 'transferring') {
      entry.lifecycle.transition('detached')
    }

    return window
  }

  // ---------------------------------------------------------------------------
  // Reintegrate
  // ---------------------------------------------------------------------------

  /**
   * Reintegrate a detached or parked pane back into the main window.
   *
   * @throws {InvalidDetachablePaneWindowTransitionError} when the pane is not
   *   in a state that allows reintegration (attached/transferring).
   */
  reintegratePane(paneId: string): void {
    const entry = this.#panes.get(paneId)
    if (!entry) {
      throw new InvalidDetachablePaneWindowTransitionError('attached', 'reintegrating')
    }

    const { lifecycle, window } = entry

    if (!canTransitionDetachablePaneWindow(lifecycle.state, 'reintegrating')) {
      throw new InvalidDetachablePaneWindowTransitionError(lifecycle.state, 'reintegrating')
    }

    lifecycle.transition('reintegrating')

    // Close the window if it still exists (parked → window already null)
    if (window && !window.isDestroyed()) {
      window.close()
    }
    entry.window = null

    lifecycle.transition('attached')
    // Entry (and its seed) is dropped only after a full reintegrate cycle. The
    // `pane:returned` broadcast happens one level up, in `finalizeReintegration`
    // (see detachable-pane.ts), since it needs the seed this discards.
    this.#panes.delete(paneId)
  }

  /**
   * Remove a tab from the stored seed by tab id, then return the updated seed
   * and the removed tab's ptyId so the caller can tear down the PTY. The
   * caller (IPC handler) is authoritative for PTY lifecycle; the manager only
   * mutates the seed.
   *
   * If the removed tab was the primary, the first additional tab (if any) is
   * promoted to primary. Returns the updated seed (null when no tabs remain)
   * and the removed ptyId (null when the tab had no PTY or was not found).
   */
  removeTab(
    paneId: string,
    tabId: string
  ): { seed: DetachedTerminalTabSeed | null; removedPtyId: string | null } {
    const entry = this.#panes.get(paneId)
    if (!entry?.seed) {
      return { seed: null, removedPtyId: null }
    }

    const seed = entry.seed
    const additionalTabs = seed.additionalTabs ?? []

    // Primary tab matches — promote the first additional tab if any.
    if (seed.tab.id === tabId) {
      const removedPtyId = seed.ptyId ?? null
      if (additionalTabs.length > 0) {
        const [nextPrimary, ...rest] = additionalTabs
        entry.seed = { ...nextPrimary, additionalTabs: rest.length > 0 ? rest : undefined }
      } else {
        entry.seed = null
      }
      return { seed: entry.seed, removedPtyId }
    }

    // Search additional tabs for a match.
    const idx = additionalTabs.findIndex((t) => t.tab.id === tabId)
    if (idx === -1) {
      return { seed: null, removedPtyId: null }
    }

    const removed = additionalTabs[idx]
    const removedPtyId = removed.ptyId ?? null
    const remaining = [...additionalTabs.slice(0, idx), ...additionalTabs.slice(idx + 1)]
    entry.seed = { ...seed, additionalTabs: remaining.length > 0 ? remaining : undefined }
    return { seed: entry.seed, removedPtyId }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  #createPaneWindow(paneId: string, store: Store | null): BrowserWindow {
    const savedBounds = resolveRestoredPopoutBounds(
      store?.getUI().detachablePaneBounds?.[paneId] ?? null,
      'detachable-pane'
    )

    const window = new BrowserWindow({
      width: savedBounds?.width ?? POPOUT_DEFAULT_WIDTH,
      height: savedBounds?.height ?? POPOUT_DEFAULT_HEIGHT,
      ...(savedBounds ? { x: savedBounds.x, y: savedBounds.y } : {}),
      minWidth: POPOUT_MIN_WIDTH,
      minHeight: POPOUT_MIN_HEIGHT,
      title: 'Orca Detached Pane',
      show: false,
      autoHideMenuBar: true,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0a0a' : '#ffffff',
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: true,
        // Why: scoped partition keeps zoom / storage per detached pane.
        partition: `persist:orca-detachable-pane-${paneId}`,
        webviewTag: false
      }
    })

    // Why: if wiring the window's security/persistence/load setup throws
    // partway through, the already-constructed native window must not be
    // leaked — destroy it and let the caller's rollback (detachPane's catch)
    // handle the lifecycle-entry side.
    try {
      installPopoutWindowSecurity(window.webContents)

      installPopoutBoundsPersistence(window, (bounds) => {
        const existing = store?.getUI().detachablePaneBounds ?? {}
        store?.updateUI({ detachablePaneBounds: { ...existing, [paneId]: bounds } })
      })

      // Why: native close → park, not full teardown. The pane can be reintegrated
      // later via reintegratePane. A parked pane has no hanging window — the
      // lifecycle state machine preserves the intent-to-return while the OS
      // window is fully destroyed.
      window.on('closed', () => {
        const entry = this.#panes.get(paneId)
        if (!entry || entry.window !== window) {
          return
        }

        entry.window = null

        if (entry.lifecycle.state === 'detached') {
          entry.lifecycle.transition('parked')
          // Why: a native close (red-dot/⌘W) parks the pane without going
          // through reintegratePane — the main window needs its own signal to
          // re-show the tab. See onPaneParked/registerDetachablePaneHandlers.
          for (const listener of this.#parkedListeners) {
            listener(paneId)
          }
        }
        // If reintegrating, the window close was programmatic — let reintegratePane finish.
      })

      showPopoutWhenReady(window)

      // popout.tsx reads `detachedPane` and renders DetachedTerminalPaneRoot for
      // it, the same entry point the dashboard pop-out loads with `?view=`.
      loadPopoutHtml(window, `detachedPane=${encodeURIComponent(paneId)}`)
    } catch (err) {
      if (!window.isDestroyed()) {
        window.destroy()
      }
      throw err
    }

    return window
  }
}

/** Singleton — one manager per app lifetime, shared across IPC handlers. */
export const detachablePaneWindowManager = new DetachablePaneWindowManager()
