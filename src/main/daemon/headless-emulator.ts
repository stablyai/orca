import './xterm-env-polyfill'
import { Terminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { activateOrcaTerminalUnicodeProvider } from '../../shared/terminal-unicode-provider'
import { advancePartialEscapeTail } from '../../shared/terminal-partial-escape-tail'
import { extractLastOscTitle } from '../../shared/agent-detection'
import { collectHeadlessOscLinkRanges } from './headless-osc-link-ranges'
import { extractOscScanTail, scanOsc7Uris } from './osc7-uri-extraction'
import { parseFileUriPath } from './osc7-file-uri'
import { TerminalPrivateModeTracker } from './terminal-private-mode-tracker'
import type { TerminalSnapshot, TerminalModes } from './types'
import type { TerminalOscLinkRange } from '../../shared/terminal-osc-link-ranges'

export type HeadlessEmulatorOptions = {
  cols: number
  rows: number
  scrollback?: number
  pathFlavor?: 'posix' | 'win32'
  remotePosixFileUriAuthority?: boolean
}

type TerminalWithSynchronousWrite = Terminal & {
  _core?: {
    writeSync?: (data: string) => void
  }
}

const DEFAULT_SCROLLBACK = 5000
const OSC_SCAN_TAIL_LIMIT = 4096

export class HeadlessEmulator {
  private terminal: Terminal
  private serializer: SerializeAddon
  private cwd: string | null = null
  private lastTitle: string | null = null
  private oscScanTail = ''
  private privateModes = new TerminalPrivateModeTracker()
  private restoredOscLinks: TerminalOscLinkRange[] = []
  // Why: a PTY read can end mid-escape-sequence — those bytes live in xterm's
  // parser, not the screen buffer, so serialize() drops them and the next
  // chunk's continuation renders literally after a remote snapshot restore
  // (#7329). Track the unparsed trailing partial at ingest (committed after
  // xterm parses the same bytes, like the private-mode mirror) and ship it in
  // the snapshot so the restorer can complete the sequence.
  private partialEscapeTail = ''
  private disposed = false
  private readonly pathFlavor?: 'posix' | 'win32'
  private readonly remotePosixFileUriAuthority: boolean

  constructor(opts: HeadlessEmulatorOptions) {
    this.pathFlavor = opts.pathFlavor
    this.remotePosixFileUriAuthority = opts.remotePosixFileUriAuthority === true
    this.terminal = new Terminal({
      cols: opts.cols,
      rows: opts.rows,
      scrollback: opts.scrollback ?? DEFAULT_SCROLLBACK,
      allowProposedApi: true,
      logLevel: 'off'
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

    // Why no onData wiring: this emulator exists purely for state tracking
    // (snapshots, cwd, mode flags). It MUST NOT respond to terminal query
    // sequences (DA1/DA2, DSR, OSC 10/11/12, DECRPM). The emulator parses
    // data in-process synchronously before `handleSubprocessData` forwards
    // it to the renderer over IPC, so any reply it emits would land on the
    // shell's stdin ahead of the renderer's xterm reply and win the race.
    // The renderer is the authoritative responder (it has the real theme,
    // cursor position, and paste mode); a daemon-side reply would be a
    // double-reply with wrong values. OSC 11 was the visible casualty:
    // Claude Code's /theme auto always saw the emulator's default-black
    // background regardless of Orca's configured terminal theme.
  }

  write(data: string): Promise<void> {
    if (this.disposed) {
      return Promise.resolve()
    }

    if (this.tryWriteSync(data)) {
      return Promise.resolve()
    }
    this.scanInputForOscState(data)
    return new Promise<void>((resolve) => {
      this.terminal.write(data, () => {
        // Why: snapshots combine serialized xterm state with mirrored mouse
        // modes. Commit the mirror only after xterm has parsed the same bytes.
        this.privateModes.scan(data)
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

  private tryWriteSync(data: string): boolean {
    const writeSync = (this.terminal as TerminalWithSynchronousWrite)._core?.writeSync
    if (typeof writeSync !== 'function') {
      return false
    }
    this.scanInputForOscState(data)
    // Why: hidden renderer restore snapshots are requested immediately after
    // PTY bursts; queued headless writes can snapshot half-cleared TUI rows.
    writeSync.call((this.terminal as TerminalWithSynchronousWrite)._core, data)
    this.privateModes.scan(data)
    this.partialEscapeTail = advancePartialEscapeTail(this.partialEscapeTail, data)
    return true
  }

  private scanInputForOscState(data: string): void {
    const oscInput = this.oscScanTail + data
    this.oscScanTail = this.extractOscScanTail(oscInput)
    this.scanOsc7(oscInput)
    const lastTitle = extractLastOscTitle(oscInput)
    if (lastTitle !== null) {
      this.lastTitle = lastTitle
    }
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
    const snapshotAnsi = this.normalizeSnapshotAnsiForModes(
      this.serializer.serialize({ scrollback: opts.scrollbackRows }),
      modes
    )
    return {
      snapshotAnsi,
      scrollbackAnsi: '',
      oscLinks: collectHeadlessOscLinkRanges(
        this.terminal,
        opts.scrollbackRows,
        this.restoredOscLinks
      ),
      rehydrateSequences: this.buildRehydrateSequences(modes),
      cwd: this.cwd,
      modes,
      cols: this.terminal.cols,
      rows: this.terminal.rows,
      scrollbackLines: this.terminal.buffer.normal.length - this.terminal.rows,
      lastTitle: this.lastTitle ?? undefined,
      // Why: written LAST by the restorer (after any reset) so the next live
      // chunk completes this dangling sequence instead of rendering it literally
      // (#7329). Its bytes are already counted by the snapshot seq.
      ...(this.partialEscapeTail.length > 0
        ? { pendingEscapeTailAnsi: this.partialEscapeTail }
        : {})
    }
  }

  get isAlternateScreen(): boolean {
    return this.terminal.buffer.active.type === 'alternate'
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
    return this.cwd
  }

  setCwd(cwd: string | null): void {
    this.cwd = cwd
  }

  setLastTitle(title: string): void {
    this.lastTitle = title
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

  private scanOsc7(data: string): void {
    scanOsc7Uris(data, (uri) => {
      this.parseOsc7Uri(uri)
    })
  }

  private extractOscScanTail(input: string): string {
    return extractOscScanTail(input, OSC_SCAN_TAIL_LIMIT)
  }

  private normalizeSnapshotAnsiForModes(snapshotAnsi: string, modes: TerminalModes): string {
    if (!modes.alternateScreen) {
      return snapshotAnsi
    }
    const alternateScreenMarker = '\x1b[?1049h'
    const start = snapshotAnsi.lastIndexOf(alternateScreenMarker)
    if (start === -1) {
      return snapshotAnsi
    }
    // Why: rehydrateSequences already enters the alternate screen and restores
    // mouse modes. Dropping SerializeAddon's duplicate ?1049h keeps mobile's
    // "slice from last alt-screen marker" replay from discarding those modes.
    return snapshotAnsi.slice(start + alternateScreenMarker.length)
  }

  private parseOsc7Uri(uri: string): void {
    const parsed = parseFileUriPath(uri, {
      pathFlavor: this.pathFlavor,
      remotePosixAuthority: this.remotePosixFileUriAuthority
    })
    if (parsed) {
      this.cwd = parsed
    }
  }

  private getModes(): TerminalModes {
    const buffer = this.terminal.buffer.active
    const mouseTrackingMode = this.privateModes.mouseTrackingMode
    return {
      bracketedPaste: this.terminal.modes.bracketedPasteMode,
      mouseTracking: mouseTrackingMode !== 'none',
      mouseTrackingMode,
      sgrMouseMode: this.privateModes.sgrMouseMode,
      sgrMousePixelsMode: this.privateModes.sgrMousePixelsMode,
      applicationCursor:
        buffer.type === 'normal' ? this.terminal.modes.applicationCursorKeysMode : false,
      alternateScreen: buffer.type === 'alternate'
    }
  }

  private buildRehydrateSequences(modes: TerminalModes): string {
    const seqs: string[] = []
    if (modes.alternateScreen) {
      seqs.push('\x1b[?1049h')
    }
    if (modes.bracketedPaste) {
      seqs.push('\x1b[?2004h')
    }
    if (modes.applicationCursor) {
      seqs.push('\x1b[?1h')
    }
    // Why: mobile alt-screen scroll gestures need xterm's mouse mode restored
    // from cold snapshots; OpenCode/OpenTUI enables scrollable panes this way.
    switch (modes.mouseTracking ? (modes.mouseTrackingMode ?? 'vt200') : 'none') {
      case 'x10':
        seqs.push('\x1b[?9h')
        break
      case 'vt200':
        seqs.push('\x1b[?1000h')
        break
      case 'drag':
        seqs.push('\x1b[?1002h')
        break
      case 'any':
        seqs.push('\x1b[?1003h')
        break
      case 'none':
        break
    }
    // Why: xterm tracks the mouse protocol and SGR encoding as independent
    // modes, so snapshots must preserve the encoding even when reporting is off.
    if (modes.sgrMousePixelsMode) {
      seqs.push('\x1b[?1016h')
    } else if (modes.sgrMouseMode) {
      seqs.push('\x1b[?1006h')
    }
    return seqs.join('')
  }
}
