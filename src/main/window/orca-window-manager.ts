import type { BrowserWindow, Point, WebContents } from 'electron'

export type OrcaWindowRole = 'control' | 'secondary'
export type ControlTransitionToken = number

type WindowEntry = {
  window: BrowserWindow
  role: OrcaWindowRole
  focusedAt: number
}

export class OrcaWindowManager {
  readonly #windows = new Map<number, WindowEntry>()
  #controlWindowId: number | null = null
  #focusSequence = 0
  #transitionSequence = 0
  #activeControlTransition: {
    token: ControlTransitionToken
    expectedWindowId: number
  } | null = null

  register(window: BrowserWindow, role?: OrcaWindowRole): void {
    const existing = this.#windows.get(window.id)
    if (existing) {
      existing.window = window
      return
    }
    const resolvedRole = role ?? (this.getControlWindow() ? 'secondary' : 'control')
    this.#windows.set(window.id, { window, role: resolvedRole, focusedAt: 0 })
    if (resolvedRole === 'control') {
      this.#demoteControl()
      this.#controlWindowId = window.id
    }
  }

  remove(windowId: number): void {
    const wasControl = this.#controlWindowId === windowId
    this.#windows.delete(windowId)
    if (!wasControl) {
      return
    }
    this.#controlWindowId = null
    if (this.#activeControlTransition?.expectedWindowId !== windowId) {
      this.#electControl()
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
    const previousWindowId = this.#controlWindowId
    const entry = this.#liveEntry(this.#controlWindowId)
    if (!entry) {
      return this.#controlWindowId !== previousWindowId ? this.getControlWindow() : null
    }
    return entry.window
  }

  getControlWindowId(): number | null {
    return this.getControlWindow()?.id ?? null
  }

  getWindow(windowId: number): BrowserWindow | null {
    return this.#liveEntry(windowId)?.window ?? null
  }

  getFocusedWindow(): BrowserWindow | null {
    return this.#rankedEntries().find(({ focusedAt }) => focusedAt > 0)?.window ?? null
  }

  getRole(windowId: number): OrcaWindowRole | null {
    return this.#liveEntry(windowId)?.role ?? null
  }

  getWindowForSender(sender: WebContents): BrowserWindow | null {
    if (sender.isDestroyed()) {
      return null
    }
    for (const entry of this.#liveEntries()) {
      if (entry.window.webContents === sender) {
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
    return this.#rankedEntries()[0]?.window ?? null
  }

  promoteControl(): BrowserWindow | null {
    const existing = this.getControlWindow()
    if (existing || this.#activeControlTransition) {
      return existing
    }
    return this.#electControl()
  }

  beginControlTransition(expectedWindowId: number): ControlTransitionToken | null {
    if (this.getControlWindowId() !== expectedWindowId) {
      return null
    }
    const token = ++this.#transitionSequence
    this.#activeControlTransition = { token, expectedWindowId }
    return token
  }

  electControlDuringTransition(token: ControlTransitionToken): BrowserWindow | null {
    if (this.#activeControlTransition?.token !== token) {
      return null
    }
    return this.getControlWindow() ?? this.#electControl()
  }

  finishControlTransition(token: ControlTransitionToken): boolean {
    if (this.#activeControlTransition?.token !== token) {
      return false
    }
    this.#activeControlTransition = null
    return true
  }

  isTrustedSender(sender: WebContents): boolean {
    return (
      !sender.isDestroyed() &&
      sender.getType() === 'window' &&
      this.getWindowForSender(sender) !== null
    )
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

  #electControl(): BrowserWindow | null {
    const next = this.getMostRecentWindow()
    if (!next) {
      return null
    }
    this.#windows.get(next.id)!.role = 'control'
    this.#controlWindowId = next.id
    return next
  }

  #liveEntry(windowId: number): WindowEntry | null {
    const entry = this.#windows.get(windowId)
    if (!entry || entry.window.isDestroyed()) {
      this.remove(windowId)
      return null
    }
    return entry
  }

  #liveEntries(): WindowEntry[] {
    for (const [windowId, entry] of this.#windows) {
      if (entry.window.isDestroyed()) {
        this.remove(windowId)
      }
    }
    return [...this.#windows.values()]
  }

  #rankedEntries(): WindowEntry[] {
    return this.#liveEntries().sort(
      (a, b) => b.focusedAt - a.focusedAt || a.window.id - b.window.id
    )
  }
}

export const orcaWindowManager = new OrcaWindowManager()
