import './xterm-env-polyfill'
import { Terminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { extractLastOscTitle } from '../../shared/agent-detection'
import { collectHeadlessOscLinkRanges } from './headless-osc-link-ranges'
import { extractOscScanTail, scanOsc7Uris } from './osc7-uri-extraction'
import { parseFileUriPath } from './osc7-file-uri'
import type { TerminalSnapshot, TerminalModes } from './types'
import type { TerminalOscLinkRange } from '../../shared/terminal-osc-link-ranges'

export type HeadlessEmulatorOptions = {
  cols: number
  rows: number
  scrollback?: number
}

type TerminalWithSynchronousWrite = Terminal & {
  _core?: {
    writeSync?: (data: string) => void
  }
}

const DEFAULT_SCROLLBACK = 5000
const OSC_SCAN_TAIL_LIMIT = 4096
// Why: PTY/SSH chunks can split a long combined DECSET before the final h/l.
// Keep parser state far beyond normal mode lists while still bounding memory.
const PRIVATE_MODE_SCAN_TAIL_LIMIT = 4096
type MouseTrackingMode = NonNullable<TerminalModes['mouseTrackingMode']>

export class HeadlessEmulator {
  private terminal: Terminal
  private serializer: SerializeAddon
  private cwd: string | null = null
  private lastTitle: string | null = null
  private oscScanTail = ''
  private privateModeScanTail = ''
  private mouseTrackingMode: MouseTrackingMode = 'none'
  private sgrMouseMode = false
  private sgrMousePixelsMode = false
  private restoredOscLinks: TerminalOscLinkRange[] = []
  private disposed = false

  constructor(opts: HeadlessEmulatorOptions) {
    this.terminal = new Terminal({
      cols: opts.cols,
      rows: opts.rows,
      scrollback: opts.scrollback ?? DEFAULT_SCROLLBACK,
      allowProposedApi: true,
      logLevel: 'off'
    })

    this.serializer = new SerializeAddon()
    this.terminal.loadAddon(this.serializer)

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
        this.scanPrivateModes(data)
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
    this.scanPrivateModes(data)
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
      lastTitle: this.lastTitle ?? undefined
    }
  }

  get isAlternateScreen(): boolean {
    return this.terminal.buffer.active.type === 'alternate'
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

  private scanPrivateModes(data: string): void {
    const input = this.privateModeScanTail + data
    this.privateModeScanTail = this.extractPrivateModeScanTail(input)
    // oxlint-disable-next-line no-control-regex -- terminal escape sequences require control chars
    const privateModeRe = /\x1bc|\x1b\[\?([0-9;]+)([hl])|\x9b\?([0-9;]+)([hl])/g
    let match: RegExpExecArray | null
    while ((match = privateModeRe.exec(input)) !== null) {
      if (match[0] === '\x1bc') {
        this.mouseTrackingMode = 'none'
        this.sgrMouseMode = false
        this.sgrMousePixelsMode = false
        continue
      }
      const params = match[1] ?? match[3]
      const enabled = (match[2] ?? match[4]) === 'h'
      for (const rawParam of params.split(';')) {
        if (rawParam === '') {
          continue
        }
        const param = Number(rawParam)
        if (!Number.isInteger(param)) {
          continue
        }
        if (param === 9) {
          this.mouseTrackingMode = enabled ? 'x10' : 'none'
        }
        if (param === 1000) {
          this.mouseTrackingMode = enabled ? 'vt200' : 'none'
        }
        if (param === 1002) {
          this.mouseTrackingMode = enabled ? 'drag' : 'none'
        }
        if (param === 1003) {
          this.mouseTrackingMode = enabled ? 'any' : 'none'
        }
        if (param === 1006) {
          this.sgrMouseMode = enabled
          this.sgrMousePixelsMode = false
        }
        if (param === 1016) {
          this.sgrMouseMode = false
          this.sgrMousePixelsMode = enabled
        }
      }
    }
  }

  private extractPrivateModeScanTail(input: string): string {
    const start = Math.max(input.lastIndexOf('\x1b'), input.lastIndexOf('\x9b'))
    if (start === -1) {
      return ''
    }
    const tail = input.slice(start)
    if (tail.length > PRIVATE_MODE_SCAN_TAIL_LIMIT) {
      return ''
    }
    if (tail === '\x1b' || tail === '\x1b[' || tail === '\x9b') {
      return tail
    }
    if (tail.startsWith('\x1b[?')) {
      return this.isIncompletePrivateModeParams(tail.slice(3)) ? tail : ''
    }
    if (tail.startsWith('\x9b?')) {
      return this.isIncompletePrivateModeParams(tail.slice(2)) ? tail : ''
    }
    return ''
  }

  private isIncompletePrivateModeParams(params: string): boolean {
    return /^[0-9;]*$/.test(params)
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
    const parsed = parseFileUriPath(uri)
    if (parsed) {
      this.cwd = parsed
    }
  }

  private getModes(): TerminalModes {
    const buffer = this.terminal.buffer.active
    const mouseTrackingMode = this.mouseTrackingMode
    return {
      bracketedPaste: this.terminal.modes.bracketedPasteMode,
      mouseTracking: mouseTrackingMode !== 'none',
      mouseTrackingMode,
      sgrMouseMode: this.sgrMouseMode,
      sgrMousePixelsMode: this.sgrMousePixelsMode,
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
