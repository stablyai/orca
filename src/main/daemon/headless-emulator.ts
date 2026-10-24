import './xterm-env-polyfill'
import { Terminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { activateOrcaTerminalUnicodeProvider } from '../../shared/terminal-unicode-provider'
import {
  readSavedCursorRegister,
  serializeWithAbsoluteCursor
} from '../../shared/terminal-serialize-absolute-cursor'
import { advancePartialEscapeTail } from '../../shared/terminal-partial-escape-tail'
import type { TerminalViewAttributes } from '../../shared/terminal-view-attributes'
import { collectHeadlessOscLinkRanges } from './headless-osc-link-ranges'
import { readTerminalModes, trackModifyOtherKeys } from './headless-emulator-modes'
import { buildRehydrateSequences } from './terminal-mode-rehydrate-sequences'
import { TerminalOscCwdTitleScanner } from './terminal-osc-cwd-title-scanner'
import { buildFrameRestoreSnapshotFields } from './terminal-frame-restore-sequences'
import { splitTerminalSnapshotAnsi } from './terminal-snapshot-ansi-buffers'
import {
  installTerminalViewAttributeResponder,
  type TerminalViewAttributeResponder
} from './terminal-view-attribute-responder'
import { installDeviceAttributesResponder } from './startup-device-attributes-responder'
import type { TerminalSnapshot, TerminalModes } from './types'
import type { TerminalOscLinkRange } from '../../shared/terminal-osc-link-ranges'
import type { TerminalCursorContext } from '../../shared/terminal-composer-draft'
import { readTerminalCursorLineContext } from '../../shared/terminal-cursor-line-context'
import {
  readHeadlessTerminalRows,
  readHeadlessTerminalLines,
  type HeadlessTerminalRow
} from './headless-terminal-rows'

export type HeadlessEmulatorOptions = {
  cols: number
  rows: number
  scrollback?: number
  /** Only opted-in live writes may reply; daemon Session must never supply this sink. */
  onQueryReply?: (reply: string) => void
  pathFlavor?: 'posix' | 'win32'
  remotePosixFileUriAuthority?: boolean
  wslDistro?: string
}

export type HeadlessEmulatorWriteOptions = {
  /** Opt in only for live chunks; seed, hydration and snapshot writes must never reply. */
  forwardQueryReplies?: boolean
}

type TerminalWithSynchronousWrite = Terminal & {
  _core?: {
    writeSync?: (data: string) => void
    coreService?: {
      kittyKeyboard?: { flags?: number }
    }
  }
}

const DEFAULT_SCROLLBACK = 5000
// Match renderer terminal-capability-replies.ts without importing renderer code.
const CONPTY_DA1_RESPONSE = '\x1b[?61;4c'

export class HeadlessEmulator {
  protected terminal: Terminal
  protected serializer: SerializeAddon
  private oscText: TerminalOscCwdTitleScanner
  private readonly pathFlavor?: 'posix' | 'win32'
  private readonly remotePosixFileUriAuthority: boolean
  private restoredOscLinks: TerminalOscLinkRange[] = []
  private disposed = false
  private onQueryReply: ((reply: string) => void) | null
  private conptyDa1OverrideInstalled = false
  private viewAttributeResponder: TerminalViewAttributeResponder | null = null
  // Scope replies to their live chunk so replayed queries cannot reach the PTY.
  private queryReplyForwardingDepth = 0
  // serialize() omits parser state, so preserve an incomplete escape for the next live chunk.
  private partialEscapeTail = ''

  constructor(opts: HeadlessEmulatorOptions) {
    this.pathFlavor = opts.pathFlavor
    this.remotePosixFileUriAuthority = opts.remotePosixFileUriAuthority === true
    this.oscText = new TerminalOscCwdTitleScanner({
      pathFlavor: this.pathFlavor,
      remotePosixAuthority: this.remotePosixFileUriAuthority,
      wslDistro: opts.wslDistro
    })
    this.terminal = new Terminal({
      cols: opts.cols,
      rows: opts.rows,
      scrollback: opts.scrollback ?? DEFAULT_SCROLLBACK,
      allowProposedApi: true,
      logLevel: 'off',
      // Match renderer kitty flag parsing and query responses.
      vtExtensions: { kittyKeyboard: true }
    })

    this.serializer = new SerializeAddon()
    this.terminal.loadAddon(this.serializer)
    trackModifyOtherKeys(this.terminal)

    // Match renderer cell widths to prevent shifted snapshot rows.
    this.terminal.loadAddon(new Unicode11Addon())
    activateOrcaTerminalUnicodeProvider(this.terminal)

    // Unsolicited emulator replies could race the renderer into shell input.
    this.onQueryReply = opts.onQueryReply ?? null
    if (this.onQueryReply) {
      this.terminal.onData((reply) => this.emitQueryReply(reply))
    }
  }

  /** ConPTY 1.22+ blocks at spawn awaiting a DA1 reply. */
  installConptyPrimaryDeviceAttributesOverride(): void {
    if (this.conptyDa1OverrideInstalled) {
      return
    }
    this.conptyDa1OverrideInstalled = true
    installDeviceAttributesResponder({
      parser: this.terminal.parser,
      response: CONPTY_DA1_RESPONSE,
      reply: (data) => this.emitQueryReply(data)
    })
  }

  /** Responder installers own disposal of handlers registered here. */
  get responderParser(): Terminal['parser'] {
    return this.terminal.parser
  }

  /** Headless xterm has no theme; use renderer attributes for replies, never in daemon Session. */
  installViewAttributeResponder(getBaseAttributes: () => TerminalViewAttributes | null): void {
    if (this.viewAttributeResponder) {
      return
    }
    this.viewAttributeResponder = installTerminalViewAttributeResponder({
      parser: this.terminal.parser,
      getBaseAttributes,
      emitReply: (reply) => this.emitQueryReply(reply)
    })
  }

  /** Match renderer cursor replies; pushed attributes supersede per-PTY color overrides. */
  applyPushedViewAttributes(attributes: TerminalViewAttributes): void {
    if (this.disposed) {
      return
    }
    this.terminal.options.cursorStyle = attributes.cursorStyle
    this.terminal.options.cursorBlink = attributes.cursorBlink
    this.viewAttributeResponder?.clearColorOverrides()
  }

  /** Restore kitty flags without allowing query replies. */
  applyKittyKeyboardFlags(flags: number): Promise<void> {
    if (!Number.isInteger(flags) || flags <= 0) {
      return Promise.resolve()
    }
    return this.write(`\x1b[=${flags};1u`)
  }

  private emitQueryReply(reply: string): void {
    if (this.queryReplyForwardingDepth > 0 && this.onQueryReply) {
      this.onQueryReply(reply)
    }
  }

  /** Prevent late replies from reaching a respawned PTY that reuses the session ID. */
  disableQueryReplyForwarding(): void {
    this.onQueryReply = null
  }

  write(data: string, opts: HeadlessEmulatorWriteOptions = {}): Promise<void> {
    if (this.disposed) {
      return Promise.resolve()
    }

    const forwardQueryReplies = opts.forwardQueryReplies === true
    if (this.tryWriteSync(data, { forwardQueryReplies })) {
      return Promise.resolve()
    }
    this.oscText.scan(data)
    // The empty-write callback opens forwarding at this chunk’s position in xterm’s async FIFO.
    if (forwardQueryReplies) {
      this.terminal.write('', () => {
        this.queryReplyForwardingDepth += 1
      })
    }
    return new Promise<void>((resolve) => {
      this.terminal.write(data, () => {
        if (forwardQueryReplies) {
          this.queryReplyForwardingDepth -= 1
        }
        this.partialEscapeTail = advancePartialEscapeTail(this.partialEscapeTail, data)
        resolve()
      })
    })
  }

  /** Apply cold-restore bytes before snapshotting; return false if the private sync API is unavailable. */
  writeSync(data: string): boolean {
    if (this.disposed) {
      return false
    }
    return this.tryWriteSync(data)
  }

  private tryWriteSync(data: string, opts: HeadlessEmulatorWriteOptions = {}): boolean {
    const writeSync = (this.terminal as TerminalWithSynchronousWrite)._core?.writeSync
    if (typeof writeSync !== 'function') {
      return false
    }
    this.oscText.scan(data)
    const forwardQueryReplies = opts.forwardQueryReplies === true
    if (forwardQueryReplies) {
      this.queryReplyForwardingDepth += 1
    }
    // Queued PTY writes could leave a snapshot with half-cleared TUI rows.
    try {
      writeSync.call((this.terminal as TerminalWithSynchronousWrite)._core, data)
    } finally {
      if (forwardQueryReplies) {
        this.queryReplyForwardingDepth -= 1
      }
    }
    this.partialEscapeTail = advancePartialEscapeTail(this.partialEscapeTail, data)
    return true
  }

  resize(cols: number, rows: number): void {
    if (this.disposed) {
      return
    }
    // Preserve row-indexed restored links on same-size resizes; only real resizes invalidate them.
    if (this.terminal.cols === cols && this.terminal.rows === rows) {
      return
    }
    this.restoredOscLinks = []
    this.terminal.resize(cols, rows)
  }

  // Report applied dimensions so the renderer can detect a dropped resize.
  getAppliedSize(): { cols: number; rows: number } {
    return { cols: this.terminal.cols, rows: this.terminal.rows }
  }

  getSnapshot(opts: { scrollbackRows?: number } = {}): TerminalSnapshot {
    const modes = this.getModes()
    // Absolute cursor restore avoids wrap-pending drift; carry the saved register for DECRC.
    const serializedAnsi = serializeWithAbsoluteCursor(
      this.serializer,
      this.terminal,
      { scrollback: opts.scrollbackRows },
      readSavedCursorRegister(this.terminal)
    )
    const { snapshotAnsi, scrollbackAnsi } = splitTerminalSnapshotAnsi(serializedAnsi, modes)
    const snapshot: TerminalSnapshot = {
      snapshotAnsi,
      scrollbackAnsi,
      oscLinks: collectHeadlessOscLinkRanges(
        this.terminal,
        opts.scrollbackRows,
        this.restoredOscLinks
      ),
      rehydrateSequences: buildRehydrateSequences(modes),
      ...buildFrameRestoreSnapshotFields(this.serializer, this.terminal, modes),
      cwd: this.oscText.cwd,
      modes,
      cols: this.terminal.cols,
      rows: this.terminal.rows,
      scrollbackLines: this.terminal.buffer.normal.length - this.terminal.rows,
      lastTitle: this.oscText.lastTitle ?? undefined,
      // Restore this last so the next live chunk completes the incomplete escape.
      ...(this.partialEscapeTail.length > 0
        ? { pendingEscapeTailAnsi: this.partialEscapeTail }
        : {})
    }
    return snapshot
  }

  get isAlternateScreen(): boolean {
    return this.terminal.buffer.active.type === 'alternate'
  }

  /** Carry parser state across handoff so split escape sequences survive. */
  get partialEscapeTailAnsi(): string {
    return this.partialEscapeTail
  }

  /** Ctrl+L is safe at an empty PSReadLine prompt; PowerShell’s continuation prompt (>>) is excluded. */
  isCursorOnEmptyPromptLine(): boolean {
    const buffer = this.terminal.buffer.active
    const line = buffer.getLine(buffer.baseY + buffer.cursorY)
    if (!line) {
      return false
    }
    const upToCursor = line.translateToString(true, 0, buffer.cursorX).trimEnd()
    const fullLine = line.translateToString(true).trimEnd()
    return fullLine === upToCursor && upToCursor.endsWith('>') && !upToCursor.endsWith('>>')
  }

  getVisibleLines(): string[] {
    return readHeadlessTerminalLines(this.terminal)
  }

  getVisibleRows(): HeadlessTerminalRow[] {
    return readHeadlessTerminalRows(this.terminal)
  }

  getBufferTailRows(limit: number): HeadlessTerminalRow[] {
    return readHeadlessTerminalRows(this.terminal, limit)
  }

  get isSynchronizedOutput(): boolean {
    return this.terminal.modes.synchronizedOutputMode
  }

  getVisibleBufferRange(): { start: number; endExclusive: number; totalLength: number } {
    const buffer = this.terminal.buffer.active
    const start = buffer.viewportY
    return {
      start,
      endExclusive: Math.min(buffer.length, start + this.terminal.rows),
      totalLength: buffer.length
    }
  }

  getCursorLineContext(rowsAbove = this.terminal.rows): TerminalCursorContext | null {
    return readTerminalCursorLineContext(this.terminal, rowsAbove)
  }

  getBufferTailLines(limit: number): string[] {
    return readHeadlessTerminalLines(this.terminal, limit)
  }

  getCwd(): string | null {
    return this.oscText.cwd
  }

  setCwd(cwd: string | null): void {
    this.oscText.cwd = cwd
  }

  setLastTitle(title: string): void {
    this.oscText.lastTitle = title
  }

  setRestoredOscLinks(links: TerminalOscLinkRange[] | undefined): void {
    this.restoredOscLinks = links?.slice() ?? []
  }

  clearScrollback(): void {
    this.restoredOscLinks = []
    this.terminal.clear()
  }

  dispose(): void {
    this.disposed = true
    this.terminal.dispose()
  }

  private getModes(): TerminalModes {
    return readTerminalModes(this.terminal)
  }
}
