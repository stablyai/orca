import type { BrowserWindow, Point, WebContents } from 'electron'

export type OrcaWindowRole = 'control' | 'secondary'

type WindowEntry = {
  window: BrowserWindow
  role: OrcaWindowRole
  focusedAt: number
}

export class OrcaWindowManager {
  readonly #windows = new Map<number, WindowEntry>()
  #controlWindowId: number | null = null
  #focusSequence = 0

  register(window: BrowserWindow, role?: OrcaWindowRole): void {
    const resolvedRole = role ?? (this.getControlWindow() ? 'secondary' : 'control')
    if (resolvedRole === 'control') {
      this.#demoteControl()
      this.#controlWindowId = window.id
    }
    this.#windows.set(window.id, {
      window,
      role: resolvedRole,
      focusedAt: this.#windows.get(window.id)?.focusedAt ?? 0
    })
  }

  unregister(windowId: number): void {
    this.#windows.delete(windowId)
    if (this.#controlWindowId === windowId) {
      this.#controlWindowId = null
    }
  }

  noteFocused(windowId: number): void {
    const entry = this.#liveEntry(windowId)
    if (entry) {
      entry.focusedAt = ++this.#focusSequence
    }
  }

  getControlWindow(): BrowserWindow | null {
    if (this.#controlWindowId == null) {
      return null
    }
    const entry = this.#liveEntry(this.#controlWindowId)
    if (!entry) {
      this.#controlWindowId = null
      return null
    }
    return entry.window
  }

  getRole(windowId: number): OrcaWindowRole | null {
    return this.#liveEntry(windowId)?.role ?? null
  }

  getWindowForSender(sender: WebContents): BrowserWindow | null {
    if (sender.isDestroyed()) {
      return null
    }
    for (const entry of this.#liveEntries()) {
      if (entry.window.webContents.id === sender.id) {
        return entry.window
      }
    }
    return null
  }

  getWindowAtPoint(point: Point, excludingWindowId?: number): BrowserWindow | null {
    const candidates = this.#liveEntries()
      .filter(({ window }) => window.id !== excludingWindowId && window.isVisible())
      .filter(({ window }) => {
        const bounds = window.getBounds()
        return (
          point.x >= bounds.x &&
          point.y >= bounds.y &&
          point.x < bounds.x + bounds.width &&
          point.y < bounds.y + bounds.height
        )
      })
      .sort((a, b) => b.focusedAt - a.focusedAt || a.window.id - b.window.id)
    return candidates[0]?.window ?? null
  }

  getAllWindows(): BrowserWindow[] {
    return this.#liveEntries().map(({ window }) => window)
  }

  getMostRecentWindow(): BrowserWindow | null {
    return (
      this.#liveEntries().sort((a, b) => b.focusedAt - a.focusedAt || a.window.id - b.window.id)[0]
        ?.window ?? null
    )
  }

  promoteControl(): BrowserWindow | null {
    const existing = this.getControlWindow()
    if (existing) {
      return existing
    }
    const next = this.getMostRecentWindow()
    if (!next) {
      return null
    }
    this.#windows.get(next.id)!.role = 'control'
    this.#controlWindowId = next.id
    return next
  }

  isTrustedSender(sender: WebContents): boolean {
    return sender.getType() === 'window' && this.getWindowForSender(sender) !== null
  }

  #demoteControl(): void {
    if (this.#controlWindowId == null) {
      return
    }
    const current = this.#windows.get(this.#controlWindowId)
    if (current) {
      current.role = 'secondary'
    }
  }

  #liveEntry(windowId: number): WindowEntry | null {
    const entry = this.#windows.get(windowId)
    if (!entry || entry.window.isDestroyed()) {
      this.unregister(windowId)
      return null
    }
    return entry
  }

  #liveEntries(): WindowEntry[] {
    for (const [windowId, entry] of this.#windows) {
      if (entry.window.isDestroyed()) {
        this.unregister(windowId)
      }
    }
    return [...this.#windows.values()]
  }
}

export const orcaWindowManager = new OrcaWindowManager()
