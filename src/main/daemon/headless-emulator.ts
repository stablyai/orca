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
import { buildRehydrateSequences } from './terminal-mode-rehydrate-sequences'
import { TerminalMouseModeMirror } from './terminal-mouse-mode-mirror'
import { TerminalOscCwdTitleScanner } from './terminal-osc-cwd-title-scanner'
import { splitTerminalSnapshotAnsi } from './terminal-snapshot-ansi-buffers'
import {
  installTerminalViewAttributeResponder,
  type TerminalViewAttributeResponder
} from './terminal-view-attribute-responder'
import type { TerminalSnapshot, TerminalModes } from './types'
import type { TerminalOscLinkRange } from '../../shared/terminal-osc-link-ranges'

export type HeadlessEmulatorOptions = {
  cols: number
  rows: number
  scrollback?: number
  /** Query reply sink (terminal-query-authority.md); only `forwardQueryReplies` writes emit here. The daemon Session must never pass this. */
  onQueryReply?: (reply: string) => void
  pathFlavor?: 'posix' | 'win32'
  remotePosixFileUriAuthority?: boolean
  wslDistro?: string
}

export type HeadlessEmulatorWriteOptions = {
  /** Reply ownership for this exact chunk; default false so seed/hydration/snapshot writes never forward (main-side replay guard; twin of renderer replay-guard.ts). */
  forwardQueryReplies?: boolean
}

type TerminalWithSynchronousWrite = Terminal & {
  _core?: {
    writeSync?: (data: string) => void
    // Why: kitty keyboard flags aren't on the public IModes; read the core service the CSI u handlers mutate.
    coreService?: {
      kittyKeyboard?: { flags?: number }
    }
  }
}

const DEFAULT_SCROLLBACK = 5000
// Keep in sync with the renderer twin terminal-capability-replies.ts (main must not import renderer modules).
const CONPTY_DA1_RESPONSE = '\x1b[?61;4c'

export class HeadlessEmulator {
  private terminal: Terminal
  private serializer: SerializeAddon
  private oscText: TerminalOscCwdTitleScanner
  private mouseModes = new TerminalMouseModeMirror()
  private readonly pathFlavor?: 'posix' | 'win32'
  private readonly remotePosixFileUriAuthority: boolean
  private restoredOscLinks: TerminalOscLinkRange[] = []
  private disposed = false
  private onQueryReply: ((reply: string) => void) | null
  private conptyDa1OverrideInstalled = false
  private viewAttributeResponder: TerminalViewAttributeResponder | null = null
  // Why: replies must be scoped to the exact write that carried the query, so seeds/snapshots and unsolicited emissions never leak to the PTY.
  private queryReplyForwardingDepth = 0
  // Why: a mid-escape chunk tail lives in xterm's parser, not the buffer, so serialize() drops it and it renders literal after restore (Bug E).
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
      // Why: parse CSI =/>/< u pushes so CSI ? u answers with the flags the hidden app pushed (renderer parity).
      vtExtensions: { kittyKeyboard: true }
    })

    this.serializer = new SerializeAddon()
    this.terminal.loadAddon(this.serializer)

    // Why Unicode 11: must match the renderer's char-width measurement, else emoji rows mismeasure and the mirror accumulates cell-shifted tears.
    this.terminal.loadAddon(new Unicode11Addon())
    activateOrcaTerminalUnicodeProvider(this.terminal)

    // Why gated: an emulator query reply would beat the renderer's to the shell's stdin (OSC 11 default-black was the casualty).
    this.onQueryReply = opts.onQueryReply ?? null
    if (this.onQueryReply) {
      this.terminal.onData((reply) => this.emitQueryReply(reply))
    }
  }

  /** ConPTY 1.22+ blocks at spawn awaiting a DA1 reply; answers `CSI ?61;4c` and consumes the query so xterm's default `?1;2c` can't double-reply. */
  installConptyPrimaryDeviceAttributesOverride(): void {
    // Why idempotent: installed at creation and again at spawn-mark time (which can land later), so it's never stacked.
    if (this.conptyDa1OverrideInstalled) {
      return
    }
    this.conptyDa1OverrideInstalled = true
    this.terminal.parser.registerCsiHandler({ final: 'c' }, (params) => {
      const isPrimaryQuery = params.length === 0 || (params.length === 1 && params[0] === 0)
      if (!isPrimaryQuery) {
        return false
      }
      this.emitQueryReply(CONPTY_DA1_RESPONSE)
      return true
    })
  }

  /** Headless core has no theme service, so OSC 4/10/11/12 and DSR ?996n answer from the renderer's pushed attributes; daemon Session must never call this. */
  installViewAttributeResponder(getBaseAttributes: () => TerminalViewAttributes | null): void {
    if (this.viewAttributeResponder) {
      return
    }
    this.viewAttributeResponder = installTerminalViewAttributeResponder({
      parser: this.terminal.parser,
      getBaseAttributes,
      // emitQueryReply keeps replies in the per-chunk forwarding window, so seeded/replayed queries answer no one.
      emitReply: (reply) => this.emitQueryReply(reply)
    })
  }

  /** Sets cursor options so xterm answers DECSCUSR / DECRQM 12 renderer-true; per-PTY color overrides are dropped (a theme apply overwrites them anyway). */
  applyPushedViewAttributes(attributes: TerminalViewAttributes): void {
    if (this.disposed) {
      return
    }
    this.terminal.options.cursorStyle = attributes.cursorStyle
    this.terminal.options.cursorBlink = attributes.cursorBlink
    this.viewAttributeResponder?.clearColorOverrides()
  }

  /** Re-seeds snapshot kitty flags via the live-push parse, routed unflagged so it can never answer a query (terminal-query-authority.md). */
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

  /** Severs the reply sink so a post-dispose reply can't reach a successor PTY (respawns reuse session ids). */
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
    // Why the sentinel: xterm parses writes async, so its zero-byte callback fires in FIFO order to open the window at exactly this chunk.
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
        // Why: commit the mouse-mode mirror only after xterm has parsed the same bytes (snapshots combine both).
        this.mouseModes.scan(data)
        this.partialEscapeTail = advancePartialEscapeTail(this.partialEscapeTail, data)
        resolve()
      })
    })
  }

  /** Synchronous write for cold-restore replay (async would snapshot a half-applied stream); false when writeSync is unavailable. */
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
    // Why: restore snapshots are requested right after PTY bursts; queued writes could snapshot half-cleared TUI rows.
    try {
      writeSync.call((this.terminal as TerminalWithSynchronousWrite)._core, data)
    } finally {
      if (forwardQueryReplies) {
        this.queryReplyForwardingDepth -= 1
      }
    }
    this.mouseModes.scan(data)
    this.partialEscapeTail = advancePartialEscapeTail(this.partialEscapeTail, data)
    return true
  }

  resize(cols: number, rows: number): void {
    if (this.disposed) {
      return
    }
    this.restoredOscLinks = []
    this.terminal.resize(cols, rows)
  }

  // Why: these dims proxy the child's real size, so they stay stale on a dropped resize the renderer must detect.
  getAppliedSize(): { cols: number; rows: number } {
    return { cols: this.terminal.cols, rows: this.terminal.rows }
  }

  getSnapshot(opts: { scrollbackRows?: number } = {}): TerminalSnapshot {
    const modes = this.getModes()
    // Why absolute: relative cursor restore is off by a column after a wrap-pending final row; saved-cursor rides along for DECRC.
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
      cwd: this.oscText.cwd,
      modes,
      cols: this.terminal.cols,
      rows: this.terminal.rows,
      scrollbackLines: this.terminal.buffer.normal.length - this.terminal.rows,
      lastTitle: this.oscText.lastTitle ?? undefined,
      // Why written LAST by the restorer: the next live chunk must complete this dangling sequence, not render it literally (Bug E / #7329).
      ...(this.partialEscapeTail.length > 0
        ? { pendingEscapeTailAnsi: this.partialEscapeTail }
        : {})
    }
    if (this.partialEscapeTail.length > 0) {
      // Why a separate field: consumers write their own reset sequences after the body, and any ESC after a dangling partial would abort it.
      snapshot.pendingEscapeTailAnsi = this.partialEscapeTail
    }
    return snapshot
  }

  get isAlternateScreen(): boolean {
    return this.terminal.buffer.active.type === 'alternate'
  }

  /** Dangling incomplete escape at the stream position; handoffs seed the other side so a split sequence isn't lost. */
  get partialEscapeTailAnsi(): string {
    return this.partialEscapeTail
  }

  /** PSReadLine's Ctrl+L repaint is only safe at an empty prompt; '>>' is PowerShell's continuation prompt, not empty. */
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
    const buffer = this.terminal.buffer.active
    const lines: string[] = []
    for (let row = buffer.viewportY; row < buffer.viewportY + this.terminal.rows; row += 1) {
      lines.push(buffer.getLine(row)?.translateToString(true) ?? '')
    }
    return lines
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
    const buffer = this.terminal.buffer.active
    const mouseTrackingMode = this.mouseModes.mouseTrackingMode
    return {
      bracketedPaste: this.terminal.modes.bracketedPasteMode,
      mouseTracking: mouseTrackingMode !== 'none',
      mouseTrackingMode,
      sgrMouseMode: this.mouseModes.sgrMouseMode,
      sgrMousePixelsMode: this.mouseModes.sgrMousePixelsMode,
      applicationCursor:
        buffer.type === 'normal' ? this.terminal.modes.applicationCursorKeysMode : false,
      alternateScreen: buffer.type === 'alternate',
      kittyKeyboardFlags: this.getKittyKeyboardFlags()
    }
  }

  private getKittyKeyboardFlags(): number {
    const flags = (this.terminal as TerminalWithSynchronousWrite)._core?.coreService?.kittyKeyboard
      ?.flags
    return typeof flags === 'number' ? flags : 0
  }
}
