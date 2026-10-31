import { buildProcessBoundaryGround } from '../../shared/terminal-mode-reset-profiles'
import {
  closesAppOsc133Zone,
  mayCloseUnseenAppZone,
  UNSEEN_OSC133_MARKERS
} from '../../shared/terminal-osc133-command-finished'
import { TerminalStatusFrameCursor } from '../../shared/terminal-status-frame-cursor'
import type { TerminalOwner } from '../../shared/terminal-owner'
import { TerminalArmedInputModes } from './terminal-armed-input-modes'
import { TerminalShellPromptPhase } from './terminal-shell-prompt-phase'

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
  private readonly framing = new TerminalStatusFrameCursor()
  private scanTail = ''
  private ownerState: TerminalOwner | undefined
  private generationState = 0
  private altActive = false
  private commandEnteredAlternateScreen = false
  // OSC 133 markers seen back to back since the last other output.
  private adjacentMarkers: string
  // A `D;0` a mid-stream reader cannot place yet; the shell's adjacent next prompt confirms it.
  private heldUnseenCommandEnd = false
  private readonly promptPhase = new TerminalShellPromptPhase()
  private readonly inputModes = new TerminalArmedInputModes()

  /** `joinsMidStream`: a mirror adopted from a snapshot or after a gap, not born with the PTY. */
  constructor(opts: { joinsMidStream?: boolean } = {}) {
    this.adjacentMarkers = opts.joinsMidStream ? UNSEEN_OSC133_MARKERS : ''
  }

  get owner(): TerminalOwner | undefined {
    return this.ownerState
  }

  get generation(): number {
    return this.generationState
  }

  get isAlternateScreenActive(): boolean {
    return this.altActive
  }

  /** Markers suggest an idle shell prompt; a hint only, since any program can print them. */
  get isIdleAtPrompt(): boolean {
    return this.promptPhase.atPrompt && !this.altActive
  }

  /** Input was just submitted: no prompt is idle until the next clean cycle. */
  forgetIdlePrompt(): void {
    this.promptPhase.reset()
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
    this.promptPhase.reset()
    if (opts.alternateScreen !== undefined) {
      // Restored bytes bypass scan(), so seed alternate-screen state to retain death detection.
      this.altActive = opts.alternateScreen
      this.commandEnteredAlternateScreen = opts.alternateScreen
    }
  }

  scan(chunk: string): ShellLifecycleScanEvents {
    const events: ShellLifecycleScanEvents = {}
    this.framing.scan(
      chunk,
      (span, start) => {
        const result = this.scanSpan(span)
        if (result.cleanExitCandidate) {
          events.cleanExitCandidate = result.cleanExitCandidate
        }
        if (result.uncleanDeathTriggerEnd !== undefined) {
          events.uncleanDeathTriggerEnd = Math.max(0, start + result.uncleanDeathTriggerEnd)
          events.uncleanDeathTriggerStart = Math.max(
            0,
            start + (result.uncleanDeathTriggerStart ?? 0)
          )
          return false
        }
        return true
      },
      () => {
        this.revoke()
        this.scanTail = ''
        this.adjacentMarkers = UNSEEN_OSC133_MARKERS
        this.heldUnseenCommandEnd = false
      }
    )
    return events
  }

  private scanSpan(chunk: string): ShellLifecycleScanEvents {
    const events: ShellLifecycleScanEvents = {}
    // Why the pre-filter: this runs per chunk for every session; a flood chunk
    // with no escape introducer must not pay the regex pass. Split sequences
    // stay correct because a partial one always left a non-empty scanTail.
    if (this.scanTail.length === 0 && !chunk.includes('\x1b') && !chunk.includes('\x9b')) {
      if (chunk.length > 0) {
        this.adjacentMarkers = ''
        this.heldUnseenCommandEnd = false
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
      if (this.heldUnseenCommandEnd) {
        this.heldUnseenCommandEnd = false
        // Why the prompt's own start: the held D sits in already-scanned bytes; repair goes before A.
        const promptStart = Math.max(0, match.index - previousTailLength)
        if (
          oscPayload?.[0] === 'A' &&
          markersBefore !== '' &&
          this.endCommand(events, promptStart, promptStart)
        ) {
          return events
        }
      }
      this.adjacentMarkers =
        oscPayload === undefined ? '' : (markersBefore + oscPayload.slice(0, 1)).slice(-2)
      if (match[0] === '\x1bc') {
        this.revoke()
        this.inputModes.reset()
        this.promptPhase.reset()
        this.altActive = false
        this.commandEnteredAlternateScreen = false
        continue
      }
      if (oscPayload !== undefined) {
        const marker = oscPayload[0]
        this.promptPhase.observe(oscPayload, markersBefore)
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
        if (mayCloseUnseenAppZone(markersBefore, oscPayload)) {
          this.heldUnseenCommandEnd = true
          continue
        }
        // Why the clamp: a complete OSC can never sit wholly inside the
        // carried tail (extractScanTail keeps incomplete ones only), so this
        // is > 0 by construction — the clamp only guards that invariant
        // against a future loosening of the tail extractor.
        if (
          this.endCommand(
            events,
            Math.max(0, match.index - previousTailLength),
            Math.max(0, match.index + match[0].length - previousTailLength)
          )
        ) {
          return events
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
      this.heldUnseenCommandEnd = false
    }
    return events
  }

  /** Command finished; true when the app died with its modes up and the caller must repair first. */
  private endCommand(
    events: ShellLifecycleScanEvents,
    triggerStart: number,
    triggerEnd: number
  ): boolean {
    // An alternate screen or a command's input mode still up at command-finished
    // means the app died without its own teardown; the caller must repair first.
    // Every D re-asks: a refuted one may be a nested shell's while the app lives.
    const uncleanDeath = this.inputModes.markCommandEnd() || this.altActive
    const cleanExit = !uncleanDeath && this.commandEnteredAlternateScreen && !this.altActive
    this.revoke()
    this.commandEnteredAlternateScreen = false
    if (uncleanDeath) {
      this.scanTail = ''
      events.uncleanDeathTriggerEnd = triggerEnd
      events.uncleanDeathTriggerStart = triggerStart
      return true
    }
    if (cleanExit) {
      events.cleanExitCandidate = { generation: this.generationState }
    }
    return false
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
