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
  /** Phase-5 model query responder sink (terminal-query-authority.md).
   *  When set, xterm-core auto-replies generated while parsing a write
   *  flagged `forwardQueryReplies` are forwarded here; all other emissions
   *  (seeds, hydration, snapshot replay, unsolicited core pushes) are
   *  discarded. The daemon Session must NEVER pass this — its emulator
   *  stays write-only forever (contract invariant: the daemon never
   *  answers). */
  onQueryReply?: (reply: string) => void
  pathFlavor?: 'posix' | 'win32'
  remotePosixFileUriAuthority?: boolean
  wslDistro?: string
}

export type HeadlessEmulatorWriteOptions = {
  /** Reply ownership captured at ingestion for this exact chunk. Default
   *  false is the main-side replay guard (twin of the renderer's
   *  replay-guard.ts): seed/hydration/snapshot writes never forward. */
  forwardQueryReplies?: boolean
}

type TerminalWithSynchronousWrite = Terminal & {
  _core?: {
    writeSync?: (data: string) => void
    // Why: kitty keyboard flags are not on the public IModes; read the core
    // service state the CSI =/>/< u handlers mutate.
    coreService?: {
      kittyKeyboard?: { flags?: number }
    }
  }
}

const DEFAULT_SCROLLBACK = 5000
// Keep in sync with the renderer twin in terminal-capability-replies.ts
// (main must not import renderer modules).
const CONPTY_DA1_RESPONSE = '\x1b[?61;4c'

export class HeadlessEmulator {
  private terminal: Terminal
  private serializer: SerializeAddon
  // Why: our restructure owns cwd/title via TerminalOscCwdTitleScanner and the
  // DECSET mouse modes via TerminalMouseModeMirror (functionally identical to
  // main's inline cwd/lastTitle/oscScanTail + TerminalPrivateModeTracker, which
  // only tracks the same mouse modes). restoredOscLinks/disposed/partialEscapeTail
  // are declared below.
  private oscText: TerminalOscCwdTitleScanner
  private mouseModes = new TerminalMouseModeMirror()
  private readonly pathFlavor?: 'posix' | 'win32'
  private readonly remotePosixFileUriAuthority: boolean
  private restoredOscLinks: TerminalOscLinkRange[] = []
  private disposed = false
  private onQueryReply: ((reply: string) => void) | null
  private conptyDa1OverrideInstalled = false
  private viewAttributeResponder: TerminalViewAttributeResponder | null = null
  // Why: replies must be scoped to the exact write that carried the query.
  // The window opens around the parse of a forward-flagged chunk and closes
  // with it, so seeds/snapshots and unsolicited core emissions (e.g. native
  // 997 pushes from option mutations) can never leak to the PTY.
  private queryReplyForwardingDepth = 0
  // Why: a chunk ending mid-escape leaves the sequence in xterm's parser, not
  // the buffer, so serialize() drops it and the next chunk's continuation
  // renders literal after a restore (Bug E, notes/garble-fuzz-divergences.md).
  // Committed alongside mouseModes: only after xterm parsed the same bytes.
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
      // Why: parity with the renderer's buildDefaultTerminalOptions — parse
      // CSI =/>/< u pushes so CSI ? u answers with the flags the hidden app
      // actually pushed. Write-only daemon use is unaffected: keyboard state
      // never alters serialization (terminal-query-authority.md §kitty).
      vtExtensions: { kittyKeyboard: true }
    })

    this.serializer = new SerializeAddon()
    this.terminal.loadAddon(this.serializer)

    // Why: this mirror must measure character widths exactly like the
    // renderer's xterm (Unicode 11 + ZWJ emoji joining). With the default v6
    // tables, emoji-dense rows (agent status lines) advance the cursor
    // differently here than on screen, so the mirrored buffer accumulates
    // cell-shifted tears that snapshot restores then paint back as garbage.
    this.terminal.loadAddon(new Unicode11Addon())
    activateOrcaTerminalUnicodeProvider(this.terminal)

    // Why onData is gated behind onQueryReply: by default this emulator is
    // pure state tracking and MUST NOT respond to terminal query sequences
    // (DA1/DA2, DSR, OSC 10/11/12, DECRPM). The daemon emulator parses data
    // in-process synchronously before `handleSubprocessData` forwards it to
    // the renderer over IPC, so any reply it emitted would land on the
    // shell's stdin ahead of the renderer's xterm reply and win the race —
    // a double-reply with default-xterm values (OSC 11 default-black was
    // the visible casualty). Only main's runtime per-PTY emulators pass a
    // sink, and even then replies flow only for chunks the hidden-delivery
    // gate DROPPED, where the renderer never sees the bytes and main is the
    // single answerer under main's terminal query authority.
    this.onQueryReply = opts.onQueryReply ?? null
    if (this.onQueryReply) {
      this.terminal.onData((reply) => this.emitQueryReply(reply))
    }
  }

  /** Main-side twin of the renderer's terminal-capability-replies.ts:
   *  ConPTY 1.22+ blocks at spawn waiting for a DA1 reply, and the override
   *  variant (`CSI ?61;4c`) must win. Returning true consumes the query so
   *  xterm core's default `?1;2c` cannot double-reply (custom CSI handlers
   *  run before core's; false falls through). The reply still routes through
   *  the forwarding window, so replayed/seeded bytes never answer. */
  installConptyPrimaryDeviceAttributesOverride(): void {
    // Why idempotent: the spawn mark can land after daemon stream data
    // already created the emulator, so the override is installed both at
    // creation and retrofitted at mark time — never stacked.
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

  /** Phase-5 slice-2 view-attribute bridge: the headless core has no theme
   *  service, so OSC 4/10/11/12 queries and DSR ?996n are answered from the
   *  renderer's pushed attributes via these parser handlers — never from
   *  emulator defaults. Runtime-only, like onQueryReply: the daemon Session
   *  must NEVER call this (its emulator stays write-only forever). */
  installViewAttributeResponder(getBaseAttributes: () => TerminalViewAttributes | null): void {
    if (this.viewAttributeResponder) {
      return
    }
    this.viewAttributeResponder = installTerminalViewAttributeResponder({
      parser: this.terminal.parser,
      getBaseAttributes,
      // emitQueryReply keeps replies inside the per-chunk forwarding window,
      // so seeded/replayed view-attribute queries answer no one.
      emitReply: (reply) => this.emitQueryReply(reply)
    })
  }

  /** Applies a renderer view-attribute push: cursor options make xterm core
   *  answer DECRQSS DECSCUSR / DECRQM 12 renderer-true, and the per-PTY OSC
   *  color overrides are dropped because a theme apply overwrites mutated
   *  colors on visible panes too (ThemeService._setTheme parity). Option
   *  writes happen outside any forwarding window, so any core emission they
   *  trigger is discarded (main-side replay guard). */
  applyPushedViewAttributes(attributes: TerminalViewAttributes): void {
    if (this.disposed) {
      return
    }
    this.terminal.options.cursorStyle = attributes.cursorStyle
    this.terminal.options.cursorBlink = attributes.cursorBlink
    this.viewAttributeResponder?.clearColorOverrides()
  }

  /** Re-seed parity for snapshot `modes.kittyKeyboardFlags`
   *  (terminal-query-authority.md §kitty): replays the persisted flags
   *  through the same `CSI = flags ; 1 u` parse a live push uses, so hidden
   *  `CSI ? u` reports them instead of `?0u`. Routed as an UNFLAGGED write —
   *  outside any forwarding window, it can never answer anything — and never
   *  into renderer rehydrateSequences (POST_REPLAY_REATTACH_RESET's kitty
   *  reset stays authoritative). */
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

  /** Severs the reply sink at PTY teardown. Queued writeChain links may
   *  still parse after dispose is requested, and daemon respawns reuse
   *  session ids — a late reply must never reach a successor PTY. */
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
    // Why the sentinel: xterm parses queued writes asynchronously, so opening
    // the window at enqueue time would leak it over earlier queued unflagged
    // chunks (seed/hydration bytes parsing while depth > 0). Write callbacks
    // fire in FIFO parse order, so a zero-byte write whose callback opens the
    // window brackets the parse of exactly this chunk; the data callback
    // closes it.
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
        // Why: snapshots combine serialized xterm state with mirrored mouse
        // modes. Commit the mirror only after xterm has parsed the same bytes.
        this.mouseModes.scan(data)
        this.partialEscapeTail = advancePartialEscapeTail(this.partialEscapeTail, data)
        resolve()
      })
    })
  }

  /** Synchronous write used by cold-restore log replay, where a snapshot is
   *  taken immediately after the last record and queued async writes would
   *  serialize a half-applied stream. Returns false when xterm's synchronous
   *  write path is unavailable — callers must then abandon the replay. */
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
    // Why: hidden renderer restore snapshots are requested immediately after
    // PTY bursts; queued headless writes can snapshot half-cleared TUI rows.
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

  // Why: Session.resize applies this emulator and the node-pty subprocess
  // together behind the same dead/invalid-size gate, so the emulator's dims are
  // an accurate proxy for the size the child actually took — and stay stale
  // when a resize is dropped, which is exactly the drop the renderer must detect.
  getAppliedSize(): { cols: number; rows: number } {
    return { cols: this.terminal.cols, rows: this.terminal.rows }
  }

  getSnapshot(opts: { scrollbackRows?: number } = {}): TerminalSnapshot {
    const modes = this.getModes()
    // Why serializeWithAbsoluteCursor: SerializeAddon's relative cursor
    // restore lands one column short after a margin-filling final row leaves
    // replay wrap-pending; the trailing CUP survives the alt-marker slice.
    // The saved-cursor register rides along so a post-restore DECRC lands
    // where the hidden TUI saved, not at home.
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
      // Why: written LAST by the restorer (after any reset) so the next live
      // chunk completes this dangling sequence instead of rendering it literally
      // (Bug E / #7329). Its bytes are already counted by the snapshot seq.
      ...(this.partialEscapeTail.length > 0
        ? { pendingEscapeTailAnsi: this.partialEscapeTail }
        : {})
    }
    if (this.partialEscapeTail.length > 0) {
      // Why a separate field, not part of snapshotAnsi: consumers write their
      // own reset sequences after the snapshot body, and any ESC written after
      // a dangling partial would abort it. The restorer must write this LAST,
      // immediately before post-snapshot live chunks. Its bytes are already
      // counted by the snapshot seq (they were ingested), so tail-slicing
      // arithmetic is unchanged.
      snapshot.pendingEscapeTailAnsi = this.partialEscapeTail
    }
    return snapshot
  }

  get isAlternateScreen(): boolean {
    return this.terminal.buffer.active.type === 'alternate'
  }

  /** The dangling incomplete escape at the current stream position (empty
   *  when none). Scan-authority handoffs seed the other side's fact scanners
   *  with it so a sequence split across the handoff neither mints a phantom
   *  bell (unseen OSC terminator) nor loses its fact. Contains no complete
   *  sequence by construction, so seeding can never double-fire. */
  get partialEscapeTailAnsi(): string {
    return this.partialEscapeTail
  }

  /** Why: PSReadLine's Ctrl+L repaint is only safe at an empty prompt — with
   *  pending input it re-renders at a cached buffer row that ConPTY's fixed
   *  viewport doesn't track, painting the input well below the prompt. The
   *  cursor line counts as an empty prompt when everything before the cursor
   *  ends with a single '>' and nothing follows it ('>>' is PowerShell's
   *  continuation prompt, i.e. a multiline edit in flight). */
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
