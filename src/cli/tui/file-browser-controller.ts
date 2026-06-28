import { decodeKey } from './tty-key-adapter'
import {
  clampFileIndex,
  emptyFileBrowser,
  rowIndexAtBodyRow,
  selectedRow,
  visibleTreeRows,
  type FileBrowserState,
  type FileEntry,
  type TreeRow
} from './file-browser'

type RpcClient = {
  call<T>(method: string, params?: unknown): Promise<{ result: T }>
}

type FileBrowserDeps = {
  worktreeId: () => string | undefined
  bodyHeight: () => number
  onChange: () => void
  /** Called after a file is opened as a tab so the controller can focus it. */
  onOpened: (relativePath: string) => void
}

/** Owns the Files browser: the file tree + expand state + selection, the
 *  keyboard reducer, and the files.list/files.open RPCs. Kept out of the
 *  controller so that file stays focused on layout and tab/terminal state. */
export class FileBrowserController {
  private state = emptyFileBrowser()
  // Bumped on every open/close so a stale files.list response can't overwrite a
  // newer open (or a close) after an out-of-order resolve.
  private openToken = 0

  constructor(
    private readonly client: RpcClient,
    private readonly deps: FileBrowserDeps
  ) {}

  get current(): FileBrowserState {
    return this.state
  }

  get isOpen(): boolean {
    return this.state.open
  }

  /** f / the Files button: open when closed, close when open. */
  toggle(): void {
    if (this.state.open) {
      this.close()
    } else {
      void this.open()
    }
  }

  private async open(): Promise<void> {
    const token = ++this.openToken
    const worktreeId = this.deps.worktreeId()
    if (!worktreeId) {
      return
    }
    this.state = { open: true, files: [], expanded: new Set(), index: 0 }
    this.deps.onChange()
    try {
      const { result } = await this.client.call<{ files?: FileEntry[] }>('files.list', {
        worktree: `id:${worktreeId}`
      })
      if (token === this.openToken && this.state.open) {
        this.state = { ...this.state, files: result.files ?? [] }
        this.deps.onChange()
      }
    } catch {
      // Leave the (empty) browser open; the user can Esc out.
    }
  }

  close(): void {
    this.openToken += 1
    this.state = emptyFileBrowser()
    this.deps.onChange()
  }

  handleKey(data: string): void {
    const key = decodeKey(data)
    if (!key) {
      return
    }
    // Esc or f (no text filter in tree mode, so f is free) closes the panel.
    if (key.type === 'escape' || (key.type === 'char' && key.value === 'f')) {
      this.close()
    } else if (key.type === 'up' || key.type === 'down') {
      this.moveBy(key.type === 'down' ? 1 : -1)
    } else if (key.type === 'right') {
      this.expandOrOpen(selectedRow(this.state))
    } else if (key.type === 'left') {
      this.collapse(selectedRow(this.state))
    } else if (key.type === 'enter') {
      const row = selectedRow(this.state)
      if (row?.kind === 'dir') {
        this.toggleExpand(row.path)
      } else {
        this.expandOrOpen(row)
      }
    }
  }

  /** Open the row at a clicked screen row (the tree starts 2 rows down: top bar
   *  + panel header), expanding a folder or opening a file. */
  clickRow(screenRow: number): void {
    const index = rowIndexAtBodyRow(this.state, screenRow - 2, this.deps.bodyHeight() - 1)
    if (index === null) {
      return
    }
    this.state = { ...this.state, index }
    this.expandOrOpen(visibleTreeRows(this.state)[index] ?? null)
  }

  private moveBy(delta: number): void {
    this.state = {
      ...this.state,
      index: clampFileIndex({ ...this.state, index: this.state.index + delta })
    }
    this.deps.onChange()
  }

  private expandOrOpen(row: TreeRow | null): void {
    if (!row) {
      return
    }
    if (row.kind === 'dir') {
      this.state.expanded.add(row.path)
      this.deps.onChange()
    } else {
      void this.openFile(row.path)
    }
  }

  private collapse(row: TreeRow | null): void {
    if (row?.kind === 'dir' && this.state.expanded.has(row.path)) {
      this.state.expanded.delete(row.path)
      this.deps.onChange()
    }
  }

  private toggleExpand(path: string): void {
    if (this.state.expanded.has(path)) {
      this.state.expanded.delete(path)
    } else {
      this.state.expanded.add(path)
    }
    this.deps.onChange()
  }

  private async openFile(relativePath: string): Promise<void> {
    const worktreeId = this.deps.worktreeId()
    this.close()
    if (!worktreeId) {
      return
    }
    try {
      await this.client.call('files.open', { worktree: `id:${worktreeId}`, relativePath })
      this.deps.onOpened(relativePath)
    } catch {
      // Open failed; nothing to focus.
    }
  }
}
