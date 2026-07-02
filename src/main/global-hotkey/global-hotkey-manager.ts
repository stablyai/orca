import { app, globalShortcut } from 'electron'
import type { BrowserWindow } from 'electron'
import type { Store } from '../persistence'
import { focusExistingMainWindow } from '../window/focus-existing-window'

export type GlobalHotkeyManagerOptions = {
  store: Store
  getMainWindow: () => BrowserWindow | null
  openMainWindow: () => BrowserWindow
  warn?: (message: string, error?: unknown) => void
}

/**
 * Manages registration of a system-wide global hotkey that toggles the Orca
 * main window visibility. Listens for settings changes to re-register the
 * hotkey when the user changes it in preferences.
 */
export class GlobalHotkeyManager {
  private readonly options: GlobalHotkeyManagerOptions
  private currentAccelerator: string | null = null
  private unsubscribeSettings: (() => void) | null = null

  constructor(options: GlobalHotkeyManagerOptions) {
    this.options = options
  }

  /** Register the initial hotkey and start listening for setting changes. */
  start(): void {
    const settings = this.options.store.getSettings()
    this.register(settings.globalHotkey ?? '')

    this.unsubscribeSettings = this.options.store.onSettingsChanged((updates) => {
      if ('globalHotkey' in updates && updates.globalHotkey !== undefined) {
        this.register(updates.globalHotkey)
      }
    })
  }

  /** Unregister the hotkey and stop listening for setting changes. */
  stop(): void {
    this.unregister()
    this.unsubscribeSettings?.()
    this.unsubscribeSettings = null
  }

  private register(accelerator: string): void {
    // Always unregister the previous binding first.
    this.unregister()

    const trimmed = accelerator.trim()
    if (!trimmed) {
      return
    }

    try {
      const registered = globalShortcut.register(trimmed, () => {
        this.handleHotkeyPressed()
      })
      if (registered) {
        this.currentAccelerator = trimmed
      } else {
        this.options.warn?.(
          `[global-hotkey] Failed to register global hotkey "${trimmed}". It may already be in use by another application.`
        )
      }
    } catch (error) {
      this.options.warn?.('[global-hotkey] Error registering global hotkey', error)
    }
  }

  private unregister(): void {
    if (this.currentAccelerator) {
      try {
        globalShortcut.unregister(this.currentAccelerator)
      } catch {
        // Best-effort cleanup.
      }
      this.currentAccelerator = null
    }
  }

  private handleHotkeyPressed(): void {
    const win = this.options.getMainWindow()
    const isVisibleAndFocused = Boolean(
      win && !win.isDestroyed() && win.isVisible() && win.isFocused()
    )

    if (isVisibleAndFocused) {
      // Window is frontmost, hide it.
      if (win && !win.isDestroyed()) {
        win.hide()
      }
      // Why: app.hide() is macOS-only; on Linux/Win we just hide the window.
      if (typeof app.hide === 'function') {
        app.hide()
      }
    } else {
      // Show and focus the window.
      focusExistingMainWindow({
        app,
        getWindow: () => this.options.getMainWindow(),
        openWindow: () => this.options.openMainWindow(),
        warn: this.options.warn
      })
    }
  }
}
