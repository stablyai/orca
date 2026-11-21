// Unit 6: full GlassesBridge implementing firmware semantics in-browser (spec S4), so every
// screen/renderer/nav path is exercisable in node tests without hardware.
import type {
  GlassesBridge,
  GlassesDeviceSnapshot,
  GlassesRawEvent,
  HudListContainerSpec,
  HudPageBuild,
  HudTextUpgrade,
  StartupBuildResult
} from '../glasses/glasses-bridge'
import { buildHudPage } from '../hud/hud-page-spec'
import { validateHudPage } from '../hud/hud-page-validator'

// Verified OsEventTypeList values (spec S3 / Appendix A). Kept local so the mock never
// depends on the SDK.
const OS_EVENT = {
  CLICK: 0,
  SCROLL_TOP: 1,
  SCROLL_BOTTOM: 2,
  DOUBLE_CLICK: 3,
  FOREGROUND_ENTER: 4,
  FOREGROUND_EXIT: 5,
  ABNORMAL_EXIT: 6,
  SYSTEM_EXIT: 7
} as const

function isClickEventType(eventType: number | undefined): boolean {
  // SDK quirk (spec S4/S7): CLICK (0) is normalized to `undefined` by the SDK's JSON layer.
  return eventType === OS_EVENT.CLICK || eventType === undefined
}

// Mock now rejects exactly what hardware rejects (integrator note, spec S9): the SDK's own
// validateEvenHubPageContainer twin.
function hasPageInvariantViolation(page: HudPageBuild): boolean {
  return validateHudPage(page).length > 0
}

function eventCaptureListContainer(page: HudPageBuild | null): HudListContainerSpec | null {
  if (!page) {
    return null
  }
  const container = page.containers.find((c) => c.isEventCapture === 1)
  return container && container.kind === 'list' ? container : null
}

export type MockGlassesBridgeOptions = {
  /** Default 'sys' matches the real simulator's default event source (spec S4). */
  eventSourceMode?: 'sys' | 'native'
  /** Default true reproduces the hardware quirk that omits listItemIndex for item 0. */
  omitIndexZeroQuirk?: boolean
}

type ExitDialogSelection = 'no' | 'yes'

/** Full GlassesBridge implementing firmware semantics (spec S4). */
export class MockGlassesBridge implements GlassesBridge {
  private currentPage: HudPageBuild | null = null
  private startupSpent = false
  private exitDialogOpen = false
  private exitDialogSelection: ExitDialogSelection = 'no'
  private readonly listSelection = new Map<number, number>()
  private readonly storage = new Map<string, string>()
  private readonly rawListeners = new Set<(event: GlassesRawEvent) => void>()
  private readonly deviceListeners = new Set<(snapshot: GlassesDeviceSnapshot) => void>()
  private deviceSnapshot: GlassesDeviceSnapshot = {
    connected: true,
    batteryLevel: 80,
    isWearing: true,
    isCharging: false,
    isInCase: false
  }
  private repaintScheduled = false
  private onRepaintCallback: (() => void) | null = null
  private eventSourceMode: 'sys' | 'native'
  private omitIndexZeroQuirk: boolean

  constructor(options?: MockGlassesBridgeOptions) {
    this.eventSourceMode = options?.eventSourceMode ?? 'sys'
    this.omitIndexZeroQuirk = options?.omitIndexZeroQuirk ?? true
  }

  // ---- GlassesBridge -------------------------------------------------------------------

  async createStartUpPage(page: HudPageBuild): Promise<StartupBuildResult> {
    if (this.startupSpent) {
      // Firmware trap (spec S3): retrying a spent startup latch is rejected outright.
      return 'invalid'
    }
    this.startupSpent = true
    if (hasPageInvariantViolation(page)) {
      return 'invalid'
    }
    this.setPage(page)
    return 'success'
  }

  async rebuildPage(page: HudPageBuild): Promise<boolean> {
    if (hasPageInvariantViolation(page)) {
      return false
    }
    this.setPage(page)
    return true
  }

  async upgradeText(update: HudTextUpgrade): Promise<boolean> {
    if (update.content.length > 2000) {
      return false
    }
    const page = this.currentPage
    if (!page) {
      return false
    }
    const container = page.containers.find((c) => c.id === update.id)
    if (!container || container.kind !== 'text') {
      return false
    }
    container.content = update.content
    this.scheduleRepaint()
    return true
  }

  async shutDownPage(exitMode: 0 | 1): Promise<boolean> {
    if (exitMode === 0) {
      this.currentPage = null
      this.notifyRawEvent({ source: 'sys', eventType: OS_EVENT.SYSTEM_EXIT })
      return true
    }
    this.exitDialogOpen = true
    this.exitDialogSelection = 'no'
    this.scheduleRepaint()
    this.notifyRawEvent({ source: 'sys', eventType: OS_EVENT.FOREGROUND_ENTER })
    return true
  }

  async getDeviceSnapshot(): Promise<GlassesDeviceSnapshot | null> {
    return this.deviceSnapshot
  }

  async setStoredValue(key: string, value: string): Promise<boolean> {
    if (value === '') {
      this.storage.delete(key)
    } else {
      this.storage.set(key, value)
    }
    return true
  }

  async getStoredValue(key: string): Promise<string> {
    return this.storage.get(key) ?? ''
  }

  onRawEvent(cb: (event: GlassesRawEvent) => void): () => void {
    this.rawListeners.add(cb)
    return () => this.rawListeners.delete(cb)
  }

  onDeviceStatusChanged(cb: (snapshot: GlassesDeviceSnapshot) => void): () => void {
    this.deviceListeners.add(cb)
    return () => this.deviceListeners.delete(cb)
  }

  // ---- deterministic test hooks (spec S4) -----------------------------------------------

  flushRenders(): void {
    if (this.repaintScheduled) {
      this.repaintScheduled = false
      this.onRepaintCallback?.()
    }
  }

  pageSnapshot(): HudPageBuild | null {
    return this.exitDialogOpen ? this.buildExitDialogPage() : this.currentPage
  }

  /**
   * Inject a raw firmware event as if it came from hardware. Implements the same
   * consumption rules as real firmware: list-container scroll ticks are absorbed
   * internally (selection move + repaint) until a boundary is hit, and the exit
   * dialog (once armed by shutDownPage(1)) intercepts scroll/click to resolve itself
   * before any event reaches onRawEvent listeners.
   */
  emitRaw(event: GlassesRawEvent): void {
    if (this.exitDialogOpen) {
      this.handleExitDialogEvent(event)
      return
    }
    if (this.tryConsumeListScroll(event)) {
      return
    }
    this.notifyRawEvent(event)
  }

  // ---- sim-driving helpers (keyboard/canvas input, spec S4) ------------------------------

  simulateClick(): void {
    const listContainer = eventCaptureListContainer(this.currentPage)
    if (this.exitDialogOpen) {
      this.emitRaw({ source: 'sys', eventType: OS_EVENT.CLICK })
      return
    }
    if (listContainer) {
      const idx = this.listSelection.get(listContainer.id) ?? 0
      const name = listContainer.items[idx]
      const event: GlassesRawEvent = {
        source: this.eventSourceMode === 'native' ? 'list' : 'sys',
        eventType: OS_EVENT.CLICK,
        containerId: listContainer.id,
        listItemName: name
      }
      if (!(this.omitIndexZeroQuirk && idx === 0)) {
        event.listItemIndex = idx
      }
      this.emitRaw(event)
      return
    }
    this.emitRaw({
      source: this.eventSourceMode === 'native' ? 'text' : 'sys',
      eventType: OS_EVENT.CLICK
    })
  }

  simulateDoubleClick(): void {
    this.emitRaw({ source: 'sys', eventType: OS_EVENT.DOUBLE_CLICK })
  }

  simulateScroll(direction: 'top' | 'bottom'): void {
    this.emitRaw({
      source: 'sys',
      eventType: direction === 'top' ? OS_EVENT.SCROLL_TOP : OS_EVENT.SCROLL_BOTTOM
    })
  }

  setOnRepaint(cb: (() => void) | null): void {
    this.onRepaintCallback = cb
  }

  setDeviceSnapshot(snapshot: GlassesDeviceSnapshot): void {
    this.deviceSnapshot = snapshot
    for (const cb of this.deviceListeners) {
      cb(snapshot)
    }
  }

  getListSelection(): number | undefined {
    const listContainer = eventCaptureListContainer(this.currentPage)
    return listContainer ? (this.listSelection.get(listContainer.id) ?? 0) : undefined
  }

  isExitDialogOpen(): boolean {
    return this.exitDialogOpen
  }

  // ---- internals -------------------------------------------------------------------------

  private setPage(page: HudPageBuild): void {
    this.currentPage = page
    this.listSelection.clear()
    for (const c of page.containers) {
      if (c.kind === 'list') {
        this.listSelection.set(c.id, 0)
      }
    }
    this.scheduleRepaint()
  }

  private tryConsumeListScroll(event: GlassesRawEvent): boolean {
    if (event.eventType !== OS_EVENT.SCROLL_TOP && event.eventType !== OS_EVENT.SCROLL_BOTTOM) {
      return false
    }
    const listContainer = eventCaptureListContainer(this.currentPage)
    if (!listContainer) {
      return false
    }
    const count = listContainer.items.length
    const idx = this.listSelection.get(listContainer.id) ?? 0
    if (event.eventType === OS_EVENT.SCROLL_TOP && idx > 0) {
      this.listSelection.set(listContainer.id, idx - 1)
      this.scheduleRepaint()
      return true
    }
    if (event.eventType === OS_EVENT.SCROLL_BOTTOM && idx < count - 1) {
      this.listSelection.set(listContainer.id, idx + 1)
      this.scheduleRepaint()
      return true
    }
    return false // at boundary — fall through and forward to listeners
  }

  private handleExitDialogEvent(event: GlassesRawEvent): void {
    if (event.eventType === OS_EVENT.SCROLL_TOP || event.eventType === OS_EVENT.SCROLL_BOTTOM) {
      this.exitDialogSelection = this.exitDialogSelection === 'no' ? 'yes' : 'no'
      this.scheduleRepaint()
      return
    }
    if (isClickEventType(event.eventType)) {
      const selection = this.exitDialogSelection
      this.exitDialogOpen = false
      // Firmware trap (spec S9, HIGH finding hud-navigation.ts:264): the dialog's page-clear
      // is NOT undone automatically on cancel — dismissing the dialog leaves the HUD blank
      // until something explicitly rebuilds it. Silently restoring the prior page here would
      // hide a real bug where FOREGROUND_ENTER only requests a refresh and the render queue's
      // differ then no-ops on an unchanged page.
      this.currentPage = null
      this.scheduleRepaint()
      this.notifyRawEvent({
        source: 'sys',
        eventType: selection === 'yes' ? OS_EVENT.SYSTEM_EXIT : OS_EVENT.FOREGROUND_EXIT
      })
    }
    // other events (double-click etc.) are ignored while the dialog is armed
  }

  private buildExitDialogPage(): HudPageBuild {
    const cursor = (opt: ExitDialogSelection): string =>
      this.exitDialogSelection === opt ? '> ' : '  '
    const body = `${cursor('no')}No — stay\n${cursor('yes')}Yes — exit`
    return buildHudPage({
      layout: 'text',
      header: 'Exit Orca?',
      body,
      footer: 'scroll=toggle  click=confirm'
    })
  }

  private notifyRawEvent(event: GlassesRawEvent): void {
    for (const cb of this.rawListeners) {
      cb(event)
    }
  }

  // Deliberately NOT auto-flushed via queueMicrotask: tests (and the sim-entry rAF loop)
  // control exactly when a repaint is observed by calling flushRenders() themselves.
  private scheduleRepaint(): void {
    this.repaintScheduled = true
  }
}
