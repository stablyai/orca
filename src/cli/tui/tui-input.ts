import { resolveAction, type TuiAction } from './keybinding-map'
import { worktreeSelector, type TuiCommand } from './action-dispatch'
import { type NarrowView } from './tui-layout'
import type { SessionTab } from './session-tab'
import type { LogicalKey } from './tty-key-adapter'
import type { StatusIndicatorKind } from './agent-state-indicator'
import type { WorktreeRow, WorktreeSnapshot } from './worktree-snapshot'

/** Controller overlay state, including the closures that turn user input into
 *  an RPC command (kept here so the input layer owns the command-building). */
export type ControllerOverlay =
  | { kind: 'none' }
  | { kind: 'help' }
  | { kind: 'confirm'; message: string; command: TuiCommand }
  | { kind: 'prompt'; label: string; build: (text: string) => TuiCommand | null }

/** The slice of the controller the input layer reads and mutates. Keeping it an
 *  explicit interface lets key/mouse routing live outside the controller (so
 *  each file stays small) without exposing the controller's internals wholesale. */
export type ControllerHost = {
  worktreeRows: () => readonly WorktreeRow[]
  selected: () => WorktreeRow | null
  selectedIndex: () => number
  isNarrow: () => boolean
  narrowView: () => NarrowView
  sidebarWidth: () => number
  /** Total screen columns (for sizing the horizontally-scrolled tab strip). */
  columns: () => number
  bodyHeight: () => number
  snapshot: () => WorktreeSnapshot | null
  resolveKind: (row: WorktreeRow) => StatusIndicatorKind
  /** The selected worktree's tabs (right-pane tab strip). */
  terminals: () => readonly SessionTab[]
  /** All session tabs grouped by worktree, for the nested sidebar tab lines. */
  tabsByWorktree: () => ReadonlyMap<string, readonly SessionTab[]>
  tabsExpanded: () => boolean
  /** Id of the focused tab (highlighting). */
  focusedTabId: () => string | null
  overlay: () => ControllerOverlay
  inputValue: () => string
  /** True when keystrokes/scroll target the focused terminal rather than nav. */
  terminalFocused: () => boolean
  selectIndex: (index: number) => void
  move: (delta: number) => void
  setNarrowView: (view: NarrowView) => void
  cycleFocus: () => void
  focusTerminal: () => void
  exitTerminalFocus: () => void
  scrollTerminal: (delta: number) => void
  toggleTabs: () => void
  /** Select a worktree (by flattened index) and focus one of its tabs by id. */
  jumpToTab: (index: number, tabId: string) => void
  /** Toggle the Files browser for the selected workspace (f / Files button). */
  toggleFiles: () => void
  fileBrowserOpen: () => boolean
  /** Open the file at a clicked screen row in the Files browser. */
  clickFile: (screenRow: number) => void
  /** Place the edit cursor from a body-relative click (no-op unless editing). */
  editorClick: (bodyRow: number, col: number) => void
  setOverlay: (overlay: ControllerOverlay) => void
  setInput: (value: string) => void
  runCommand: (command: TuiCommand) => void
  refresh: () => void
  quit: () => void
}

// ─── Keyboard ────────────────────────────────────────────────────────────────

export function handleKey(host: ControllerHost, key: LogicalKey): void {
  const overlay = host.overlay()
  if (overlay.kind === 'help') {
    host.setOverlay({ kind: 'none' })
    return
  }
  if (overlay.kind === 'confirm') {
    if (key.type === 'char' && key.value === 'y') {
      host.runCommand(overlay.command)
      host.setOverlay({ kind: 'none' })
    } else if (key.type === 'escape' || (key.type === 'char' && key.value === 'n')) {
      host.setOverlay({ kind: 'none' })
    }
    return
  }
  if (overlay.kind === 'prompt') {
    routePromptKey(host, overlay, key)
    return
  }
  if (key.type === 'tab') {
    host.cycleFocus()
    return
  }
  const action = resolveAction(key)
  if (!action) {
    return
  }
  // Enter focuses the terminal for input: in narrow this opens the terminal
  // view (which is implicitly focused); in wide it captures keystrokes.
  if (action === 'open') {
    if (host.isNarrow()) {
      if (host.selected()) {
        host.setNarrowView('terminal')
      }
    } else if (host.terminals().length > 0) {
      host.focusTerminal()
    }
    return
  }
  startAction(host, action)
}

function routePromptKey(
  host: ControllerHost,
  overlay: Extract<ControllerOverlay, { kind: 'prompt' }>,
  key: LogicalKey
): void {
  if (key.type === 'enter') {
    const command = overlay.build(host.inputValue())
    host.setOverlay({ kind: 'none' })
    if (command) {
      host.runCommand(command)
    }
  } else if (key.type === 'escape') {
    host.setOverlay({ kind: 'none' })
  } else if (key.type === 'backspace') {
    host.setInput(host.inputValue().slice(0, -1))
  } else if (key.type === 'char') {
    host.setInput(host.inputValue() + key.value)
  }
}

function startAction(host: ControllerHost, action: TuiAction): void {
  if (action === 'quit') {
    host.quit()
  } else if (action === 'help') {
    host.setOverlay({ kind: 'help' })
  } else if (action === 'refresh') {
    host.refresh()
  } else if (action === 'move-up') {
    host.move(-1)
  } else if (action === 'move-down') {
    host.move(1)
  } else if (action === 'toggle-tabs') {
    host.toggleTabs()
  } else if (action === 'files') {
    host.toggleFiles()
  } else {
    startTargetedAction(host, action)
  }
}

function startTargetedAction(host: ControllerHost, action: TuiAction): void {
  const selected = host.selected()
  if (!selected) {
    return
  }
  const wt = worktreeSelector(selected.worktreeId)
  if (action === 'activate') {
    host.runCommand({ kind: 'worktree.activate', worktree: wt })
  } else if (action === 'remove-worktree') {
    host.setOverlay({
      kind: 'confirm',
      message: `Remove worktree "${selected.displayName}"?`,
      command: { kind: 'worktree.rm', worktree: wt, force: true }
    })
  } else if (action === 'new-terminal') {
    openPrompt(host, 'New terminal command (blank for a shell):', (text) => ({
      kind: 'terminal.create',
      worktree: wt,
      command: text || undefined
    }))
  } else if (action === 'new-worktree') {
    openPrompt(host, `New worktree name (repo ${selected.repoId}):`, (text) =>
      text ? { kind: 'worktree.create', repo: `id:${selected.repoId}`, name: text } : null
    )
  }
}

function openPrompt(
  host: ControllerHost,
  label: string,
  build: (text: string) => TuiCommand | null
): void {
  host.setInput('')
  host.setOverlay({ kind: 'prompt', label, build })
}
