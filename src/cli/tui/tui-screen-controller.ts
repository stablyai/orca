import {
  ALT_SCREEN_ENTER,
  ALT_SCREEN_LEAVE,
  AUTOWRAP_OFF,
  AUTOWRAP_ON,
  CLEAR_SCREEN,
  HIDE_CURSOR,
  SHOW_CURSOR
} from './ansi-control'
import { MOUSE_DISABLE, MOUSE_ENABLE, parseMouseEvents } from './mouse-input'
import { decodeKey } from './tty-key-adapter'
import { ScreenCompositor } from './screen-compositor'
import { composeFrame, type FrameModel } from './compose-frame'
import { contextLabel, toOverlayModel } from './frame-derivation'
import { handleKey, type ControllerHost, type ControllerOverlay } from './tui-input'
import { handleMouse, routeOverlayClick } from './tui-mouse'
import { WorktreeSnapshotSource, type WorktreeSnapshotState } from './worktree-snapshot-source'
import { flattenWorktreeRows, type WorktreeRow } from './worktree-snapshot'
import { FocusedTabPane } from './focused-tab-pane'
import { dispatchAction, type TuiCommand } from './action-dispatch'
import { SessionTabsRegistry } from './session-tabs-registry'
import { FileBrowserController } from './file-browser-controller'
import { DoubleEscapeDetector } from './double-escape'
import { IndicatorDebounceMap } from './indicator-debounce-map'
import { clampSelection, moveSelection } from './navigation-state'
import { currentPlatform } from './keybinding-map'
import { resolveTheme } from './theme'
import {
  HEADER_ROWS,
  NARROW_THRESHOLD,
  sidebarWidthFor,
  viewportCellDims,
  type NarrowView
} from './tui-layout'
import type { RunTuiOptions } from './tui-runtime-contract'

/** The manual screen controller: owns the terminal directly (herdr-style) and
 *  drives a diff-based compositor instead of Ink, so the right pane can carry
 *  the focused terminal's verbatim ANSI output. Input routing lives in
 *  ./tui-input; this class owns state, the data sources, and rendering. */
export class TuiScreenController {
  private readonly options: RunTuiOptions
  private readonly source: WorktreeSnapshotSource
  private readonly compositor: ScreenCompositor
  private readonly useColor = resolveTheme().useColor
  private readonly platform = currentPlatform()

  private snap: WorktreeSnapshotState
  private selectedIndex = 0
  private tabsExpanded = true
  private narrow: NarrowView = 'list'
  private overlay: ControllerOverlay = { kind: 'none' }
  private input = ''
  private error: string | null = null
  private readonly files: FileBrowserController
  private readonly pane: FocusedTabPane
  private readonly tabs: SessionTabsRegistry

  private size = { columns: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24 }
  private readonly indicators = new IndicatorDebounceMap()

  private renderQueued = false
  private resolveExit: (() => void) | null = null
  private disposed = false
  private readonly doubleEsc = new DoubleEscapeDetector()

  private readonly onData = (chunk: Buffer | string): void => this.handleStdin(chunk)
  private readonly onResize = (): void => this.handleResize()

  constructor(options: RunTuiOptions) {
    this.options = options
    this.source = new WorktreeSnapshotSource(options.client)
    this.compositor = new ScreenCompositor()
    this.snap = this.source.getState()
    this.pane = new FocusedTabPane(options.client, () => this.render())
    this.tabs = new SessionTabsRegistry(
      options.client,
      this.pane,
      () => this.selectedWorktreeId(),
      () => this.render()
    )
    this.files = new FileBrowserController(options.client, {
      worktreeId: () => this.selectedWorktreeId(),
      bodyHeight: () => Math.max(1, this.size.rows - HEADER_ROWS - 1),
      onChange: () => this.render(),
      onOpened: (path) => void this.tabs.sync().then(() => this.tabs.focusOpened(path))
    })
  }

  private selectedWorktreeId(): string | undefined {
    return this.worktreeRows()[this.selectedIndex]?.worktreeId
  }

  run(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.resolveExit = resolve
      const enter = this.options.noAltScreen ? '' : ALT_SCREEN_ENTER
      process.stdout.write(enter + HIDE_CURSOR + AUTOWRAP_OFF + MOUSE_ENABLE + CLEAR_SCREEN)
      const stdin = process.stdin
      if (stdin.isTTY) {
        stdin.setRawMode?.(true)
      }
      stdin.resume()
      stdin.on('data', this.onData)
      process.stdout.on('resize', this.onResize)
      this.source.subscribe((state) => this.handleSnapshot(state))
      this.source.start()
      void this.tabs.sync()
      this.render()
    })
  }

  // ─── Host bridge for ./tui-input ─────────────────────────────────────────

  private readonly host: ControllerHost = {
    worktreeRows: () => this.worktreeRows(),
    selected: () => this.worktreeRows()[this.selectedIndex] ?? null,
    selectedIndex: () => this.selectedIndex,
    isNarrow: () => this.size.columns < NARROW_THRESHOLD,
    narrowView: () => this.narrow,
    sidebarWidth: () => sidebarWidthFor(this.size.columns),
    columns: () => this.size.columns,
    bodyHeight: () => Math.max(1, this.size.rows - HEADER_ROWS - 1),
    snapshot: () => this.snap.snapshot,
    resolveKind: (row) => this.indicators.kindFor(row),
    terminals: () => this.tabs.forSelected(),
    tabsByWorktree: () => this.tabs.byWorktreeMap,
    tabsExpanded: () => this.tabsExpanded,
    focusedTabId: () => this.pane.tabId,
    overlay: () => this.overlay,
    inputValue: () => this.input,
    terminalFocused: () => this.inputFocused(),
    focusTerminal: () => this.pane.focusInput(),
    exitTerminalFocus: () => this.exitTerminalFocus(),
    scrollTerminal: (delta) => this.pane.scroll(delta),
    toggleTabs: () => this.update(() => (this.tabsExpanded = !this.tabsExpanded)),
    jumpToTab: (index, tabId) => this.jumpToTab(index, tabId),
    toggleFiles: () => this.files.toggle(),
    fileBrowserOpen: () => this.files.isOpen,
    clickFile: (screenRow) => this.files.clickRow(screenRow),
    editorClick: (bodyRow, col) => this.pane.clickAt(bodyRow, col),
    selectIndex: (index) => this.selectIndex(index),
    move: (delta) =>
      this.selectIndex(moveSelection(this.selectedIndex, delta, this.worktreeRows().length)),
    setNarrowView: (view) => this.update(() => (this.narrow = view)),
    cycleFocus: () => this.pane.cycle(this.tabs.forSelected()),
    setOverlay: (overlay) => this.update(() => (this.overlay = overlay)),
    setInput: (value) => this.update(() => (this.input = value)),
    runCommand: (command) => void this.runCommand(command),
    refresh: () => void this.source.refreshOnce(),
    quit: () => this.quit()
  }

  private handleStdin(chunk: Buffer | string): void {
    const data = chunk.toString()
    const mouse = parseMouseEvents(data)
    if (mouse.length > 0) {
      // An open dialog captures clicks too (yes/no/dismiss); otherwise route normally.
      for (const event of mouse) {
        if (this.overlay.kind === 'none') {
          handleMouse(this.host, event)
        } else {
          routeOverlayClick(this.host, this.overlay, this.input, this.platform, this.size, event)
        }
      }
      return
    }
    // An open dialog (confirm/prompt/help) captures keys regardless of terminal
    // or editor focus, so y/n reaches the close dialog while a tab is focused.
    if (this.overlay.kind !== 'none') {
      const overlayKey = decodeKey(data)
      if (overlayKey) {
        handleKey(this.host, overlayKey)
      }
      return
    }
    if (this.files.isOpen) {
      this.files.handleKey(data)
      return
    }
    // While the terminal is focused, forward raw keystrokes to the PTY verbatim
    // (so escapes/control chars pass through); Ctrl-] is the way back to nav.
    if (this.inputFocused()) {
      // Ctrl-] (\x1d, matched even when batched) or a double-Esc returns to nav.
      if (data.includes('\x1d') || this.doubleEsc.test(data, Date.now())) {
        this.exitTerminalFocus()
      } else {
        this.pane.sendKeys(data)
      }
      return
    }
    const key = decodeKey(data)
    if (key) {
      handleKey(this.host, key)
    }
  }

  // ─── Snapshot + selection ──────────────────────────────────────────────────

  private handleSnapshot(state: WorktreeSnapshotState): void {
    // Anchor selection to the worktree id so activity-driven reordering of the
    // list doesn't switch the workspace (and its terminal) out from under the user.
    const keepId = this.worktreeRows()[this.selectedIndex]?.worktreeId
    this.snap = state
    if (this.snap.snapshot) {
      this.indicators.reconcile(this.worktreeRows(), Date.now())
    }
    const rows = this.worktreeRows()
    const kept = keepId ? rows.findIndex((row) => row.worktreeId === keepId) : -1
    this.selectedIndex = kept >= 0 ? kept : clampSelection(this.selectedIndex, rows.length)
    void this.tabs.sync()
    this.render()
  }

  private worktreeRows(): WorktreeRow[] {
    return this.snap.snapshot ? flattenWorktreeRows(this.snap.snapshot) : []
  }

  private jumpToTab(index: number, tabId: string): void {
    this.selectIndex(index)
    this.pane.setTab(this.tabs.focus(tabId))
    this.pane.focusInput()
  }

  // ─── Terminal input focus (delegated to the pane) ──────────────────────────

  /** True when keystrokes/scroll target the terminal: the pane's explicit
   *  wide-mode focus, or implicitly whenever the narrow terminal view is open. */
  private inputFocused(): boolean {
    // Mode-exclusive: in narrow, focus follows the view (so going back to the
    // list returns input to workspace navigation); the wide-only pane.focused
    // flag must not leak across a resize into the narrow list view.
    return this.size.columns < NARROW_THRESHOLD ? this.narrow === 'terminal' : this.pane.focused
  }

  private exitTerminalFocus(): void {
    this.pane.exitInput()
    if (this.size.columns < NARROW_THRESHOLD) {
      this.narrow = 'list'
    }
    this.render()
  }

  // ─── State setters + geometry ──────────────────────────────────────────────

  private selectIndex(index: number): void {
    const next = clampSelection(index, this.worktreeRows().length)
    if (next === this.selectedIndex) {
      return
    }
    this.selectedIndex = next
    this.tabs.ensureFocused()
    this.render()
  }

  /** Apply a state mutation, then re-render. */
  private update(mutate: () => void): void {
    mutate()
    this.render()
  }

  private async runCommand(command: TuiCommand): Promise<void> {
    const result = await dispatchAction(this.options.client, command)
    this.error = result.ok ? null : result.error
    if (result.ok) {
      void this.source.refreshOnce()
    }
    this.render()
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  private handleResize(): void {
    this.size = { columns: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24 }
    this.compositor.reset()
    this.render()
  }

  private render(): void {
    if (this.disposed || this.renderQueued) {
      return
    }
    this.renderQueued = true
    setImmediate(() => {
      this.renderQueued = false
      if (!this.disposed) {
        this.pane.fit(
          viewportCellDims(
            this.size.columns,
            Math.max(1, this.size.rows - HEADER_ROWS - 1),
            this.size.columns < NARROW_THRESHOLD
          )
        )
        this.compositor.render(composeFrame(this.frameModel()))
      }
    })
  }

  private frameModel(): FrameModel {
    const rows = this.worktreeRows()
    this.selectedIndex = clampSelection(this.selectedIndex, rows.length)
    const selected = rows[this.selectedIndex] ?? null
    return {
      columns: this.size.columns,
      rows: this.size.rows,
      isNarrow: this.size.columns < NARROW_THRESHOLD,
      narrowView: this.narrow,
      snapshot: this.snap.snapshot,
      worktreeRows: rows,
      selectedIndex: this.selectedIndex,
      selectedName: selected?.displayName ?? '',
      sidebarWidth: sidebarWidthFor(this.size.columns),
      tabs: this.tabs.forSelected(),
      tabsByWorktree: this.tabs.byWorktreeMap,
      tabsExpanded: this.tabsExpanded,
      focusedTabId: this.pane.tabId,
      terminalFocused: this.inputFocused(),
      editState: this.pane.editState,
      fileBrowser: this.files.current,
      viewport: this.pane.viewport,
      scrollOffset: this.pane.scrollOffset,
      resolveKind: this.indicators.kindFor,
      platform: this.platform,
      context: contextLabel(selected),
      disconnected: !this.snap.connected,
      error: this.error,
      useColor: this.useColor,
      overlay: toOverlayModel(this.overlay, this.input, this.platform)
    }
  }

  private quit(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.pane.stop()
    this.source.stop()
    const stdin = process.stdin
    stdin.off('data', this.onData)
    process.stdout.off('resize', this.onResize)
    if (stdin.isTTY) {
      stdin.setRawMode?.(false)
    }
    stdin.pause()
    // Restore a visible cursor + default shape, drop mouse reporting, leave the
    // alt screen — herdr's restore postlude so a quit never strands the terminal.
    const leave = this.options.noAltScreen ? '' : ALT_SCREEN_LEAVE
    process.stdout.write(`${SHOW_CURSOR}\x1b[0 q${AUTOWRAP_ON}${MOUSE_DISABLE}${leave}`)
    this.resolveExit?.()
  }
}
