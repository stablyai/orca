import './xterm-env-polyfill'
import { Terminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { activateOrcaTerminalUnicodeProvider } from '../../../shared/terminal/appearance/terminal-unicode-provider'
import {
  readSavedCursorRegister,
  serializeWithAbsoluteCursor
} from '../../../shared/terminal/replay/terminal-serialize-absolute-cursor'
import { advancePartialEscapeTail } from '../../../shared/terminal/protocol/escape/terminal-partial-escape-tail'
import { CONPTY_DA1_RESPONSE } from '../../../shared/conpty-device-attributes'
import { resizeLikeOwnPty } from './conpty-reflow-viewport'
import { DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT } from '../../../shared/terminal/replay/terminal-scrollback-policy'
import type { TerminalViewAttributes } from '../../../shared/terminal/protocol/queries/terminal-view-attributes'
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
import type { TerminalSnapshot } from '../protocol/terminal-snapshot'
import type { TerminalOscLinkRange } from '../../../shared/terminal/links/terminal-osc-link-ranges'
import type { TerminalCursorContext } from '../../../shared/terminal/input/terminal-composer-draft'
import { readTerminalCursorLineContext } from '../../../shared/terminal/input/terminal-cursor-line-context'
import {
  readHeadlessTerminalRows,
  isHeadlessCursorOnEmptyPrompt,
  readHeadlessVisibleBufferRange,
  readHeadlessTerminalLines,
  type HeadlessTerminalRow
} from './headless-terminal-rows'
import { HeadlessContentOrigins } from './headless-content-origins'
import type { TerminalContentOrigin } from '../../../shared/terminal/output/terminal-content-origin'

import type {
  HeadlessEmulatorOptions,
  HeadlessEmulatorWriteOptions
} from './headless-emulator-options'
export type {
  HeadlessEmulatorOptions,
  HeadlessEmulatorWriteOptions
} from './headless-emulator-options'

type TerminalWithSynchronousWrite = Terminal & {
  _core?: {
    writeSync?: (data: string) => void
    coreService?: {
      kittyKeyboard?: { flags?: number }
    }
  }
}

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
  private contentOrigins?: HeadlessContentOrigins

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
      scrollback: opts.scrollback ?? DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT,
      allowProposedApi: true,
      logLevel: 'off',
      // Match renderer kitty flag parsing and query responses.
      vtExtensions: { kittyKeyboard: true },
      windowsPty: opts.windowsPty ?? {}
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
    if (opts.contentOrigin && !this.contentOrigins) {
      this.contentOrigins = new HeadlessContentOrigins(this.terminal)
    }
    if (this.tryWriteSync(data, opts)) {
      return Promise.resolve()
    }
    this.oscText.scan(data)
    // The empty-write callback opens forwarding at this chunk’s position in xterm’s async FIFO.
    if (forwardQueryReplies || this.contentOrigins) {
      this.terminal.write('', () => {
        if (forwardQueryReplies) {
          this.queryReplyForwardingDepth += 1
        }
        this.contentOrigins?.begin(opts.contentOrigin)
      })
    }
    return new Promise<void>((resolve) => {
      this.terminal.write(data, () => {
        if (forwardQueryReplies) {
          this.queryReplyForwardingDepth -= 1
        }
        this.contentOrigins?.end()
        this.partialEscapeTail = advancePartialEscapeTail(this.partialEscapeTail, data)
        resolve()
      })
    })
  }

  /** Apply cold-restore bytes before snapshotting; return false if the private sync API is unavailable. */
  writeSync(data: string): boolean {
    return !this.disposed && this.tryWriteSync(data)
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
    this.contentOrigins?.begin(opts.contentOrigin)
    try {
      writeSync.call((this.terminal as TerminalWithSynchronousWrite)._core, data)
    } finally {
      this.contentOrigins?.end()
      if (forwardQueryReplies) {
        this.queryReplyForwardingDepth -= 1
      }
    }
    this.partialEscapeTail = advancePartialEscapeTail(this.partialEscapeTail, data)
    return true
  }

  resize(cols: number, rows: number): void {
    // Preserve row-indexed restored links on same-size resizes; only real resizes invalidate them.
    if (this.disposed || (this.terminal.cols === cols && this.terminal.rows === rows)) {
      return
    }
    this.restoredOscLinks = []
    const writeSync = this.partialEscapeTail ? null : (data: string) => void this.writeSync(data)
    this.contentOrigins?.materialize()
    resizeLikeOwnPty(this.terminal, cols, rows, writeSync)
    this.contentOrigins?.resized()
  }

  // Report applied dimensions so the renderer can detect a dropped resize.
  getAppliedSize(): { cols: number; rows: number } {
    return { cols: this.terminal.cols, rows: this.terminal.rows }
  }

  getSnapshot(opts: { scrollbackRows?: number } = {}): TerminalSnapshot {
    const modes = readTerminalModes(this.terminal)
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
    return isHeadlessCursorOnEmptyPrompt(this.terminal)
  }

  getVisibleLines(): string[] {
    return readHeadlessTerminalLines(this.terminal)
  }

  getVisibleActionLines(scope: TerminalContentOrigin): string[] {
    return this.contentOrigins?.read(scope) ?? this.getVisibleLines()
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
    return readHeadlessVisibleBufferRange(this.terminal)
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
    this.contentOrigins?.materialize()
    this.terminal.clear()
  }

  dispose(): void {
    this.disposed = true
    this.terminal.dispose()
  }
}
