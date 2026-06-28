import { TerminalAnsiSource, emptyAnsiFrame, type TerminalAnsiFrame } from './terminal-ansi-source'
import { terminalLineCount } from './viewport-frame'
import { sendTerminalKeys } from './action-dispatch'
import { renderMarkdown } from './render-markdown'
import { FileEditor } from './file-editor'
import { highlightLine, languageFromPath } from './syntax-highlight'
import { saveFileTab } from './file-save'
import { decodeKey } from './tty-key-adapter'
import type { TuiRpcClient } from './tui-rpc-client'
import type { SessionTab } from './session-tab'

/** terminal.updateViewport viewport bounds (runtime schema). */
const FIT_MIN_COLS = 20
const FIT_MAX_COLS = 240
const FIT_MIN_ROWS = 8
const FIT_MAX_ROWS = 120

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function linesToFrame(lines: string[]): TerminalAnsiFrame {
  return { data: null, cols: 0, rows: 0, plainLines: lines, connected: true, plainFallback: true }
}

function plainFrame(content: string): TerminalAnsiFrame {
  return linesToFrame(content.split('\n'))
}

/** Owns the focused tab: which tab is shown, the content frame it renders, the
 *  scroll offset, and (for terminals) input focus. Terminal tabs poll readAnsi
 *  live; file/markdown tabs read their content once; browser tabs show a URL —
 *  so the viewport can render any tab kind, not just terminals. */
export class FocusedTabPane {
  private tab: SessionTab | null = null
  private source: TerminalAnsiSource | null = null
  private frame: TerminalAnsiFrame = emptyAnsiFrame()
  private scrollback = 0
  private inputFocused = false
  private fitCols = 0
  private fitRows = 0
  private editor: FileEditor | null = null
  /** First buffer line shown while editing, so a click maps to the right line. */
  private editorTop = 0
  /** Syntax highlighter for the open file (identity until a file is loaded). */
  private highlight: (line: string) => string = (line) => line
  /** Set when files.read shows the file changed on disk since load; a second
   *  Ctrl-S then overwrites. */
  private saveConflict = false

  constructor(
    private readonly client: TuiRpcClient,
    private readonly onChange: () => void
  ) {}

  /** The focused tab's id (for highlighting the active tab). */
  get tabId(): string | null {
    return this.tab?.id ?? null
  }

  /** The focused terminal handle, when the tab is a terminal (for input/fit). */
  get handle(): string | null {
    return this.tab?.kind === 'terminal' ? this.tab.terminalHandle : null
  }

  get viewport(): TerminalAnsiFrame {
    return this.frame
  }

  get scrollOffset(): number {
    return this.scrollback
  }

  get focused(): boolean {
    return this.inputFocused
  }

  /** Editor status for the footer: none (not editing) / clean / dirty / conflict
   *  (the file changed on disk since load — a second Ctrl-S overwrites). */
  get editState(): 'none' | 'clean' | 'dirty' | 'conflict' {
    if (!this.editor) {
      return 'none'
    }
    if (this.saveConflict) {
      return 'conflict'
    }
    return this.editor.dirty ? 'dirty' : 'clean'
  }

  setTab(tab: SessionTab | null): void {
    if (tab?.id === this.tab?.id) {
      return
    }
    this.tab = tab
    this.scrollback = 0
    this.fitCols = 0
    this.fitRows = 0
    this.editor = null
    this.editorTop = 0
    this.highlight = (line) => line
    this.saveConflict = false
    if (!tab) {
      this.inputFocused = false
    }
    this.source?.stop()
    this.source = null
    this.frame = emptyAnsiFrame()
    this.loadContent(tab)
    this.onChange()
  }

  /** Re-apply the latest metadata for the already-focused tab without resetting
   *  scroll/editor state. Arms the live source for a terminal that just became
   *  ready (its handle appears after the pending→ready transition). */
  refresh(tab: SessionTab): void {
    this.tab = tab
    if (tab.kind === 'terminal' && tab.terminalHandle && !this.source) {
      this.loadContent(tab)
      this.onChange()
    }
  }

  /** Start the live readAnsi poll for a terminal tab, or fetch static content
   *  for a file/markdown/browser tab. */
  private loadContent(tab: SessionTab | null): void {
    if (!tab) {
      return
    }
    if (tab.kind === 'terminal') {
      if (!tab.terminalHandle) {
        return
      }
      const source = new TerminalAnsiSource(this.client, tab.terminalHandle)
      source.subscribe((frame) => {
        this.frame = frame
        this.onChange()
      })
      source.start()
      this.source = source
      return
    }
    if (tab.kind === 'browser') {
      this.frame = plainFrame(
        `URL: ${tab.url ?? '(unknown)'}\n\n(browser tabs open in the Orca app)`
      )
      return
    }
    this.fetchFile(tab)
  }

  /** Read a file/markdown tab's content once and show it (newest content wins if
   *  the focused tab hasn't changed since the request). */
  private fetchFile(tab: SessionTab): void {
    if (!tab.relativePath) {
      this.frame = plainFrame(`(no source path for ${tab.title})`)
      return
    }
    void this.client
      .call<{ content?: string; truncated?: boolean }>('files.read', {
        worktree: `id:${tab.worktreeId}`,
        relativePath: tab.relativePath
      })
      .then(({ result }) => {
        if (this.tab?.id !== tab.id) {
          return
        }
        const content = result.content ?? ''
        if (tab.kind === 'markdown') {
          // Markdown renders read-only with basic formatting.
          this.frame = linesToFrame(renderMarkdown(content))
        } else if (result.truncated) {
          // The runtime caps files.read; editing + a full-overwrite save would
          // truncate the file on disk, so show large files read-only.
          this.frame = linesToFrame([
            '(file too large to edit — showing the first part, read-only)',
            '',
            ...content.split('\n')
          ])
        } else {
          // Other files open in an editable, syntax-highlighted buffer.
          const lang = languageFromPath(tab.relativePath)
          this.highlight = (line) => highlightLine(line, lang)
          this.editor = new FileEditor()
          this.editor.load(content)
          this.frame = linesToFrame(this.editor.renderLines(this.highlight))
        }
        this.onChange()
      })
      .catch(() => {
        if (this.tab?.id === tab.id) {
          this.frame = plainFrame(`(could not read ${tab.relativePath})`)
          this.onChange()
        }
      })
  }

  cycle(tabs: readonly SessionTab[]): void {
    if (tabs.length === 0) {
      return
    }
    const current = tabs.findIndex((tab) => tab.id === this.tab?.id)
    this.setTab(tabs[(current + 1) % tabs.length])
  }

  focusInput(): void {
    this.inputFocused = true
    this.scrollback = 0
    this.onChange()
  }

  exitInput(): void {
    this.inputFocused = false
    this.onChange()
  }

  scroll(delta: number): void {
    if (this.editor) {
      // delta > 0 scrolls toward the top of the file (older lines), so the
      // window's top line moves up. The frame is unchanged — only the offset.
      const maxTop = Math.max(0, this.editor.lineCount - Math.max(1, this.fitRows))
      const top = clamp(this.editorTop - delta, 0, maxTop)
      if (top === this.editorTop) {
        return
      }
      this.editorTop = top
      this.syncEditorScroll()
      this.onChange()
      return
    }
    const max = Math.max(0, terminalLineCount(this.frame) - 1)
    const next = Math.min(Math.max(this.scrollback + delta, 0), max)
    if (next === this.scrollback) {
      return
    }
    this.scrollback = next
    this.onChange()
  }

  /** Route input: editor keys when editing a file (Ctrl-S saves, Ctrl-G
   *  discards), otherwise raw bytes to the focused terminal. */
  sendKeys(data: string): void {
    if (this.editor) {
      this.editKey(data, this.editor)
      return
    }
    const handle = this.handle
    if (handle) {
      void sendTerminalKeys(this.client, handle, data)
    }
  }

  private editKey(data: string, editor: FileEditor): void {
    const key = decodeKey(data)
    if (!key) {
      return
    }
    if (key.type === 'ctrl' && key.value === 's') {
      this.save(editor)
      return
    }
    if (key.type === 'ctrl' && key.value === 'g') {
      editor.revert()
      // Discarding clears the conflict so the next Ctrl-S re-checks the disk
      // instead of silently force-overwriting.
      this.saveConflict = false
    } else if (!editor.handleKey(key)) {
      return
    }
    this.revealCursor()
    this.frame = linesToFrame(editor.renderLines(this.highlight))
    this.onChange()
  }

  /** Write the buffer; a conflicting external change flags saveConflict so the
   *  footer warns and a second Ctrl-S (allowOverwrite) writes anyway. */
  private save(editor: FileEditor): void {
    const tab = this.tab
    if (!tab?.relativePath) {
      return
    }
    const id = tab.id
    void saveFileTab(
      this.client,
      `id:${tab.worktreeId}`,
      tab.relativePath,
      editor,
      this.saveConflict
    ).then((result) => {
      if (this.tab?.id !== id || result === 'failed') {
        return
      }
      this.saveConflict = result === 'conflict'
      this.onChange()
    })
  }

  /** Derive the viewport offset from editorTop (the tail-window the viewport
   *  draws then starts exactly at editorTop, so clicks map back cleanly). */
  private syncEditorScroll(): void {
    if (!this.editor) {
      return
    }
    const maxTop = Math.max(0, this.editor.lineCount - Math.max(1, this.fitRows))
    this.editorTop = clamp(this.editorTop, 0, maxTop)
    this.scrollback = Math.max(
      0,
      this.editor.lineCount - Math.max(1, this.fitRows) - this.editorTop
    )
  }

  /** Scroll the window just enough to show the cursor — only when it moves, so
   *  passive renders don't yank the view back (the wheel can scroll away). */
  private revealCursor(): void {
    if (!this.editor) {
      return
    }
    const height = Math.max(1, this.fitRows)
    if (this.editor.cursorRow < this.editorTop) {
      this.editorTop = this.editor.cursorRow
    } else if (this.editor.cursorRow >= this.editorTop + height) {
      this.editorTop = this.editor.cursorRow - height + 1
    }
    this.syncEditorScroll()
  }

  /** Set the editing cursor from a viewport click at (bodyRow, col). */
  clickAt(bodyRow: number, col: number): void {
    if (!this.editor || bodyRow < 0) {
      return
    }
    this.editor.setCursorFromClick(this.editorTop + bodyRow, col)
    this.revealCursor()
    this.frame = linesToFrame(this.editor.renderLines(this.highlight))
    this.onChange()
  }

  /** Resize the focused PTY to the viewport (terminal tabs only) via the desktop
   *  updateViewport path — no input-floor side effect. No-op when unchanged. */
  fit({ cols, rows }: { cols: number; rows: number }): void {
    if (this.editor) {
      // Passive render: keep the user's scroll position, just re-derive the
      // offset for the current height. Cursor reveal happens on edit/click only.
      this.fitRows = Math.max(1, rows)
      this.syncEditorScroll()
      return
    }
    const handle = this.handle
    const c = clamp(cols, FIT_MIN_COLS, FIT_MAX_COLS)
    const r = clamp(rows, FIT_MIN_ROWS, FIT_MAX_ROWS)
    if (!handle || (c === this.fitCols && r === this.fitRows)) {
      return
    }
    this.fitCols = c
    this.fitRows = r
    void this.client
      .call('terminal.updateViewport', {
        terminal: handle,
        client: { id: 'orca-tui', type: 'desktop' },
        viewport: { cols: c, rows: r }
      })
      .catch(() => {
        // Older runtimes lack updateViewport; the pane still clips to width.
      })
  }

  stop(): void {
    this.source?.stop()
  }
}
