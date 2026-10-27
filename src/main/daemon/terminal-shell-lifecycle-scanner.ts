import { buildProcessBoundaryGround } from '../../shared/terminal-mode-reset-profiles'
import { closesAppOsc133Zone } from '../../shared/terminal-osc133-command-finished'
import type { TerminalOwner } from '../../shared/terminal-owner'
import { TerminalArmedInputModes } from './terminal-armed-input-modes'

// Retain split DECSET/OSC payloads across PTY or SSH chunks without unbounded memory.
const SCAN_TAIL_LIMIT = 4096

// These enables invalidate cached shell ownership until fresh proof arrives.
const TUI_MODE_ENABLES = new Set([47, 1000, 1002, 1003, 1004, 1005, 1006, 1015, 1016, 1047, 1049])
const ALTERNATE_SCREEN_MODES = new Set([47, 1047, 1049])

// oxlint-disable-next-line no-control-regex -- terminal escape sequences require control chars
const LIFECYCLE_OSC = /\x1b\]133;([^\x07\x1b]*)(?:\x07|\x1b\\)/
// oxlint-disable-next-line no-control-regex -- terminal escape sequences require control chars
const PRIVATE_MODE = /\x1b\[\?([0-9;]*)([hl])|\x9b\?([0-9;]*)([hl])/
// oxlint-disable-next-line no-control-regex -- terminal escape sequences require control chars
const KITTY_KEYBOARD = /\x1b\[([<>=])([0-9;]*)u|\x9b([<>=])([0-9;]*)u/
// oxlint-disable-next-line no-control-regex -- terminal escape sequences require control chars
const FULL_RESET = /\x1bc/
// oxlint-disable-next-line no-control-regex -- terminal escape sequences require control chars
const MODIFY_OTHER_KEYS = /\x1b\[>4(?:;([0-9]*))?m|\x9b>4(?:;([0-9]*))?m/

// Groups: 1 OSC payload; 2–5 private mode; 6–9 kitty prefix/params; 10–11 XTMODKEYS level.
const SEQUENCE_RE = new RegExp(
  [LIFECYCLE_OSC, PRIVATE_MODE, KITTY_KEYBOARD, FULL_RESET, MODIFY_OTHER_KEYS]
    .map((re) => re.source)
    .join('|'),
  'g'
)

export type ShellLifecycleScanEvents = {
  /** Chunk index after a suspected-death OSC 133;D; the caller must refeed the unconsumed remainder. */
  uncleanDeathTriggerEnd?: number
  /** Where that OSC 133;D begins in the chunk; 0 when it began in an earlier one. */
  uncleanDeathTriggerStart?: number
  /** An OSC 133;D closed a command that had entered the alternate screen and left it cleanly. */
  cleanExitCandidate?: { generation: number }
}

/** Feed terminal bytes in order; generation checks reject ownership proofs invalidated by later output. */
export class TerminalShellLifecycleScanner {
  private scanTail = ''
  private ownerState: TerminalOwner | undefined
  private generationState = 0
  private altActive = false
  private commandEnteredAlternateScreen = false
  private adjacentMarkers = ''
  private readonly inputModes = new TerminalArmedInputModes()

  get owner(): TerminalOwner | undefined {
    return this.ownerState
  }

  get generation(): number {
    return this.generationState
  }

  get isAlternateScreenActive(): boolean {
    return this.altActive
  }

  trySetOwner(generation: number): boolean {
    if (generation !== this.generationState) {
      return false
    }
    this.ownerState = 'shell'
    return true
  }

  groundProcessBoundary(): string {
    const ground = buildProcessBoundaryGround({
      keepFocusReporting: this.inputModes.hostOwnsFocusReporting
    })
    this.scan(ground)
    return ground
  }

  seedOwner(owner: TerminalOwner | undefined, opts: { alternateScreen?: boolean } = {}): void {
    this.generationState += 1
    this.ownerState = owner
    if (opts.alternateScreen !== undefined) {
      // Restored bytes bypass scan(), so seed alternate-screen state to retain death detection.
      this.altActive = opts.alternateScreen
      this.commandEnteredAlternateScreen = opts.alternateScreen
    }
  }

  scan(chunk: string): ShellLifecycleScanEvents {
    const events: ShellLifecycleScanEvents = {}
    // Skip regex work on plain output; an incomplete escape already leaves scanTail nonempty.
    if (this.scanTail.length === 0 && !chunk.includes('\x1b') && !chunk.includes('\x9b')) {
      if (chunk.length > 0) {
        this.adjacentMarkers = ''
      }
      return events
    }
    const previousTailLength = this.scanTail.length
    const input = previousTailLength === 0 ? chunk : this.scanTail + chunk
    this.scanTail = this.extractScanTail(input)
    // The shared regex is safe because scan() is synchronous and never re-enters.
    SEQUENCE_RE.lastIndex = 0
    let match: RegExpExecArray | null
    let outputEnd = 0
    while ((match = SEQUENCE_RE.exec(input)) !== null) {
      const oscPayload = match[1]
      const markersBefore = match.index > outputEnd ? '' : this.adjacentMarkers
      outputEnd = match.index + match[0].length
      this.adjacentMarkers =
        oscPayload === undefined ? '' : (markersBefore + oscPayload.slice(0, 1)).slice(-2)
      if (match[0] === '\x1bc') {
        this.revoke()
        this.inputModes.reset()
        this.altActive = false
        this.commandEnteredAlternateScreen = false
        continue
      }
      if (oscPayload !== undefined) {
        const marker = oscPayload[0]
        if (marker === 'C') {
          this.revoke()
          this.inputModes.markCommandStart()
          this.commandEnteredAlternateScreen = false
          continue
        }
        if (marker === 'A') {
          this.inputModes.markPrompt()
        }
        // An app closing its own OSC zone is still running; its D does not prove exit (#10923).
        if (marker !== 'D' || closesAppOsc133Zone(markersBefore, oscPayload)) {
          continue
        }
        // Armed modes suggest unclean death, but each D needs proof because nested shells also emit it.
        const uncleanDeath = this.inputModes.markCommandEnd() || this.altActive
        const cleanExit = !uncleanDeath && this.commandEnteredAlternateScreen && !this.altActive
        this.revoke()
        this.commandEnteredAlternateScreen = false
        if (uncleanDeath) {
          this.scanTail = ''
          // Clamp the chunk-relative boundary defensively; carried tails contain only incomplete sequences.
          events.uncleanDeathTriggerEnd = Math.max(
            0,
            match.index + match[0].length - previousTailLength
          )
          events.uncleanDeathTriggerStart = Math.max(0, match.index - previousTailLength)
          return events
        }
        if (cleanExit) {
          events.cleanExitCandidate = { generation: this.generationState }
        }
        continue
      }
      if (match[0].endsWith('m')) {
        // Our injected ground disarms XTMODKEYS; only enables revoke ownership.
        const level = Number(match[10] ?? match[11] ?? '') || 0
        if (level > 0) {
          this.revoke()
        }
        this.inputModes.applyModifyOtherKeys(level)
        continue
      }
      const kittyPrefix = match[6] ?? match[8]
      if (kittyPrefix !== undefined) {
        // Our reset pops and clears kitty flags; only nonzero push/set parameters revoke ownership.
        const kittyParams = match[7] ?? match[9] ?? ''
        const first = Number(kittyParams.split(';')[0])
        if (kittyPrefix !== '<' && Number.isInteger(first) && first > 0) {
          this.revoke()
        }
        this.inputModes.applyKittyKeyboard(kittyPrefix, kittyParams)
        continue
      }
      const enabled = (match[3] ?? match[5]) === 'h'
      for (const rawParam of (match[2] ?? match[4] ?? '').split(';')) {
        if (rawParam === '') {
          continue
        }
        const param = Number(rawParam)
        if (!Number.isInteger(param)) {
          continue
        }
        if (enabled && TUI_MODE_ENABLES.has(param)) {
          this.revoke()
        }
        this.inputModes.applyPrivateMode(param, enabled)
        if (ALTERNATE_SCREEN_MODES.has(param)) {
          this.inputModes.switchScreen(enabled)
          this.altActive = enabled
          if (enabled) {
            this.commandEnteredAlternateScreen = true
          }
        }
      }
    }
    if (input.length - this.scanTail.length > outputEnd) {
      this.adjacentMarkers = ''
    }
    return events
  }

  private revoke(): void {
    this.generationState += 1
    this.ownerState = undefined
  }

  private extractScanTail(input: string): string {
    const oscStart = input.lastIndexOf('\x1b]')
    if (oscStart !== -1 && isIncompleteLifecycleOsc(input.slice(oscStart))) {
      return boundTail(input.slice(oscStart))
    }
    const start = Math.max(input.lastIndexOf('\x1b'), input.lastIndexOf('\x9b'))
    if (start === -1) {
      return ''
    }
    const tail = boundTail(input.slice(start))
    if (tail === '\x1b' || tail === '\x1b[' || tail === '\x9b' || tail === '') {
      return tail
    }
    const params = tail.startsWith('\x1b[')
      ? tail.slice(2)
      : tail.startsWith('\x9b')
        ? tail.slice(1)
        : undefined
    return params !== undefined && /^[?<>=][0-9;]*$/.test(params) ? tail : ''
  }
}

function boundTail(tail: string): string {
  return tail.length > SCAN_TAIL_LIMIT ? '' : tail
}

/** `tail` starts with `\x1b]`; true only while it could still become a complete OSC 133. */
function isIncompleteLifecycleOsc(tail: string): boolean {
  const body = tail.slice(2)
  if (body.length < 4) {
    return '133;'.startsWith(body)
  }
  // Payload may end mid-ST: the trailing ESC is the first half of `\x1b\`.
  // oxlint-disable-next-line no-control-regex -- terminal escape sequences require control chars
  return body.startsWith('133;') && /^[^\x07\x1b]*\x1b?$/.test(body.slice(4))
}
