import type { TerminalOwner } from '../../shared/terminal-owner'

// Why: PTY/SSH chunks can split a long combined DECSET or an OSC 133 payload
// before its terminator. Keep parser state far beyond normal sequence lengths
// while still bounding memory.
const SCAN_TAIL_LIMIT = 4096

// Any mode a full-screen or mouse-driven app arms: once one appears the shell
// is no longer the thing writing to this pane.
const TUI_MODE_ENABLES = new Set([47, 1000, 1002, 1003, 1004, 1005, 1006, 1015, 1016, 1047, 1049])
const ALTERNATE_SCREEN_MODES = new Set([47, 1047, 1049])

// oxlint-disable-next-line no-control-regex -- terminal escape sequences require control chars
const LIFECYCLE_OSC = /\x1b\]133;([^\x07\x1b]*)(?:\x07|\x1b\\)/
// oxlint-disable-next-line no-control-regex -- terminal escape sequences require control chars
const PRIVATE_MODE = /\x1b\[\?([0-9;]*)([hl])|\x9b\?([0-9;]*)([hl])/
// oxlint-disable-next-line no-control-regex -- terminal escape sequences require control chars
const KITTY_KEYBOARD = /\x1b\[([>=])([0-9;]*)u|\x9b([>=])([0-9;]*)u/
// oxlint-disable-next-line no-control-regex -- terminal escape sequences require control chars
const FULL_RESET = /\x1bc/

// Groups: 1 OSC 133 payload, 2/3 and 4/5 private-mode params + final, 6/7 and 8/9 kitty prefix + params.
const SEQUENCE_RE = new RegExp(
  [LIFECYCLE_OSC, PRIVATE_MODE, KITTY_KEYBOARD, FULL_RESET].map((re) => re.source).join('|'),
  'g'
)

export type ShellLifecycleScanEvents = {
  /**
   * Index into the chunk just handed to `scan()`, one past the terminator of an
   * OSC 133;D that arrived while the alternate screen was still active. Bytes at
   * and after this index were NOT consumed; the caller re-feeds them.
   */
  uncleanDeathTriggerEnd?: number
  /** An OSC 133;D closed a command that had entered the alternate screen and left it cleanly. */
  cleanExitCandidate?: { generation: number }
}

/**
 * Streaming, chunk-split-safe scanner of raw PTY output that tracks which side
 * owns the stream. Callers must feed `scan()` the same bytes the terminal
 * parsed, in order.
 *
 * Ownership is generation-guarded rather than a plain flag: an async consumer
 * that decides "the shell owns this pane" from an event must prove no revoking
 * sequence slipped in between, which `trySetOwner()` checks.
 */
export class TerminalShellLifecycleScanner {
  private scanTail = ''
  private ownerState: TerminalOwner | undefined
  private generationState = 0
  private altActive = false
  private commandEnteredAlternateScreen = false
  // Why one-shot: a refuted proof leaves altActive true (no reset was ever
  // scanned), and without disarming every later prompt's D would re-open a
  // full pause-and-inspect episode. Only a fresh alternate-screen entry re-arms.
  private uncleanTriggerArmed = false

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

  seedOwner(owner: TerminalOwner | undefined, opts: { alternateScreen?: boolean } = {}): void {
    this.generationState += 1
    this.ownerState = owner
    if (opts.alternateScreen !== undefined) {
      // Why seeded mode state matters: restored bytes bypass scan(), so without
      // this a mirror seeded mid-TUI never arms its unclean-death trigger and
      // the whole occupancy loses recovery.
      this.altActive = opts.alternateScreen
      this.uncleanTriggerArmed = opts.alternateScreen
      this.commandEnteredAlternateScreen = opts.alternateScreen
    }
  }

  scan(chunk: string): ShellLifecycleScanEvents {
    const events: ShellLifecycleScanEvents = {}
    // Why the pre-filter: this runs per chunk for every session; a flood chunk
    // with no escape introducer must not pay the regex pass. Split sequences
    // stay correct because a partial one always left a non-empty scanTail.
    if (this.scanTail.length === 0 && !chunk.includes('\x1b') && !chunk.includes('\x9b')) {
      return events
    }
    const previousTailLength = this.scanTail.length
    const input = previousTailLength === 0 ? chunk : this.scanTail + chunk
    this.scanTail = this.extractScanTail(input)
    // The shared regex is safe because scan() is synchronous and never re-enters.
    SEQUENCE_RE.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = SEQUENCE_RE.exec(input)) !== null) {
      const oscPayload = match[1]
      if (match[0] === '\x1bc') {
        this.revoke()
        this.altActive = false
        this.commandEnteredAlternateScreen = false
        this.uncleanTriggerArmed = false
        continue
      }
      if (oscPayload !== undefined) {
        const marker = oscPayload[0]
        if (marker === 'C') {
          this.revoke()
          this.commandEnteredAlternateScreen = false
          continue
        }
        if (marker !== 'D') {
          continue
        }
        // An alternate screen still up at command-finished means the app died
        // without its own teardown; the caller must repair before more bytes land.
        const uncleanDeath = this.altActive && this.uncleanTriggerArmed
        const cleanExit = !uncleanDeath && this.commandEnteredAlternateScreen && !this.altActive
        this.revoke()
        this.commandEnteredAlternateScreen = false
        if (uncleanDeath) {
          this.uncleanTriggerArmed = false
          this.scanTail = ''
          // Why the clamp: a complete OSC can never sit wholly inside the
          // carried tail (extractScanTail keeps incomplete ones only), so this
          // is > 0 by construction — the clamp only guards that invariant
          // against a future loosening of the tail extractor.
          events.uncleanDeathTriggerEnd = Math.max(
            0,
            match.index + match[0].length - previousTailLength
          )
          return events
        }
        if (cleanExit) {
          events.cleanExitCandidate = { generation: this.generationState }
        }
        continue
      }
      const kittyPrefix = match[6] ?? match[8]
      if (kittyPrefix !== undefined) {
        // `CSI < n u` (pop) and `CSI = 0 u` (clear) appear in our own injected
        // reset, so only a push of real flags counts as a new owner.
        const first = Number((match[7] ?? match[9] ?? '').split(';')[0])
        if (Number.isInteger(first) && first > 0) {
          this.revoke()
        }
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
        if (ALTERNATE_SCREEN_MODES.has(param)) {
          this.altActive = enabled
          if (enabled) {
            this.commandEnteredAlternateScreen = true
            this.uncleanTriggerArmed = true
          }
        }
      }
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
    return params !== undefined && /^[?>=][0-9;]*$/.test(params) ? tail : ''
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
