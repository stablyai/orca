import './xterm-env-polyfill'
import { Terminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { activateOrcaTerminalUnicodeProvider } from '../../shared/terminal-unicode-provider'
import { advancePartialEscapeTail } from '../../shared/terminal-partial-escape-tail'
import type { TerminalViewAttributes } from '../../shared/terminal-view-attributes'
import { readTerminalModes } from './headless-emulator-modes'
import { TerminalMouseModeMirror } from './terminal-mouse-mode-mirror'
import { TerminalOscCwdTitleScanner } from './terminal-osc-cwd-title-scanner'
import {
  installTerminalViewAttributeResponder,
  type TerminalViewAttributeResponder
} from './terminal-view-attribute-responder'
import { installDeviceAttributesResponder } from './startup-device-attributes-responder'
import type { TerminalSnapshot, TerminalModes } from './types'
import type { TerminalOscLinkRange } from '../../shared/terminal-osc-link-ranges'
import type { TerminalCursorContext } from '../../shared/terminal-composer-draft'
import { readTerminalCursorLineContext } from '../../shared/terminal-cursor-line-context'
import { HeadlessSnapshotCache } from './headless-snapshot-cache'

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
  private readonly snapshotCache = new HeadlessSnapshotCache()

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

  /** ConPTY 1.22+ blocks at spawn awaiting a DA1 reply. See startup-device-attributes-responder. */
  installConptyPrimaryDeviceAttributesOverride(): void {
    // Why idempotent: installed at creation and again at spawn-mark time (which can land later), so it's never stacked.
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

  /** Why exposed: responder modules install handlers here (see the view-attribute and
   *  device-attributes responders); the caller owns disposal. */
  get responderParser(): Terminal['parser'] {
    return this.terminal.parser
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
    this.markMutated()
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

  /** Invalidates the snapshot cache; called by every mutation of a MEMOIZED
   *  part (buffer, dimensions, modes, OSC links). Fields the snapshot re-reads
   *  per build — cwd, lastTitle, the escape tail — deliberately do not. */
  private markMutated(): void {
    this.snapshotCache.markMutated()
  }

  /**
   * Bumps only for real bytes. Why this is safe even though a zero-byte write
   * is NOT inert — `_core.writeSync('')` drains xterm's pending queue and
   * applies it (verified) — is that a fence can never introduce an
   * unattributed mutation. Any bytes it drains belong to a queued async write,
   * and xterm runs that write's completion callback first, which bumps. The
   * two write regimes are exhaustive: with writeSync present every write takes
   * the sync path and nothing can queue; without it every write is async and
   * self-bumps. Fences are exempt because flushParsedWrites() is one, and
   * every getSettledSnapshot runs it — bumping would evict the cache on each
   * checkpoint read.
   */
  private markWritten(data: string): void {
    if (data.length > 0) {
      this.markMutated()
    }
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
    // Why after the sync attempt: tryWriteSync bumps for the path it handles,
    // so bumping first would double-count it and blur which bump owns which path.
    if (this.tryWriteSync(data, { forwardQueryReplies })) {
      return Promise.resolve()
    }
    this.markWritten(data)
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
        // Why again: xterm parses asynchronously, so the buffer only reaches
        // its post-write state here; the entry bump alone would let a
        // snapshot taken mid-parse cache a half-applied buffer.
        this.markWritten(data)
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
    this.markWritten(data)
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
    // Why the equality gate: every attach re-asserts the pane's dimensions, so
    // an unconditional bump made a reattach of an idle session miss its own
    // cached snapshot — the exact case the cache exists for. A resize to the
    // size already applied changes nothing the snapshot reads.
    if (this.terminal.cols === cols && this.terminal.rows === rows) {
      return
    }
    this.markMutated()
    this.restoredOscLinks = []
    this.terminal.resize(cols, rows)
  }

  // Why: these dims proxy the child's real size, so they stay stale on a dropped resize the renderer must detect.
  getAppliedSize(): { cols: number; rows: number } {
    return { cols: this.terminal.cols, rows: this.terminal.rows }
  }

  getSnapshot(opts: { scrollbackRows?: number } = {}): TerminalSnapshot {
    return this.snapshotCache.build(
      {
        serializer: this.serializer,
        terminal: this.terminal,
        restoredOscLinks: this.restoredOscLinks,
        readModes: () => this.getModes(),
        cwd: this.oscText.cwd,
        lastTitle: this.oscText.lastTitle,
        partialEscapeTail: this.partialEscapeTail
      },
      opts.scrollbackRows
    )
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
    const buffer = this.terminal.buffer.active
    const start = Math.max(0, buffer.length - Math.max(0, Math.floor(limit)))
    const lines: string[] = []
    for (let row = start; row < buffer.length; row += 1) {
      lines.push(buffer.getLine(row)?.translateToString(true) ?? '')
    }
    return lines
  }

  getCwd(): string | null {
    return this.oscText.cwd
  }

  // Why no invalidation: the snapshot reads cwd/lastTitle fresh on every build,
  // so they are never memoized. Bumping here would discard a whole serialize —
  // and OSC 7 cwd updates land on every `cd`.
  setCwd(cwd: string | null): void {
    this.oscText.cwd = cwd
  }

  /** See setCwd: lastTitle is read fresh per build, never memoized. */
  setLastTitle(title: string): void {
    this.oscText.lastTitle = title
  }

  setRestoredOscLinks(links: TerminalOscLinkRange[] | undefined): void {
    this.markMutated()
    this.restoredOscLinks = links?.slice() ?? []
  }

  clearScrollback(): void {
    this.markMutated()
    this.restoredOscLinks = []
    this.terminal.clear()
  }

  // Why no invalidation: a post-dispose getSnapshot re-serializes the disposed
  // terminal to byte-identical content, so bumping bought nothing and only
  // reached into a disposed xterm. Serving the retained entry is equivalent
  // and touches nothing.
  dispose(): void {
    this.disposed = true
    this.terminal.dispose()
  }

  private getModes(): TerminalModes {
    return readTerminalModes(this.terminal, this.mouseModes)
  }
}
