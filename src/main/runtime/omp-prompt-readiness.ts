const OSC_START = '\x1b]'
const MAX_CARRY = 512

// Verified OMP 18.0.10 composer paste normalization, then editor submit trim.
// The caller supplies the actual pasted text (after Orca's ESC sanitization).
export function normalizeOmpPromptInput(text: string): string {
  return (
    text
      .replace(/\r\n?/g, '\n')
      .normalize('NFC')
      .replace(/\t/g, '   ')
      // eslint-disable-next-line no-control-regex -- Why: match OMP's removal of non-newline C0 controls from pasted text.
      .replace(/[\x00-\x09\x0B-\x1F]/g, '')
      .trim()
  )
}

/** Readiness and correlated input receipts are separate; neither proves task completion. */
export class OmpPromptReadiness {
  ready = false
  // Monotonic for this PTY observer; readiness revocation cannot erase a turn-start edge.
  submittedSequence = 0
  submittedFingerprint: string | null = null
  private carry = ''

  reset(): void {
    this.ready = false
    this.submittedFingerprint = null
    this.carry = ''
  }

  ingest(data: string): void {
    const input = this.carry + data
    this.carry = ''
    let cursor = 0
    while (cursor < input.length) {
      const start = input.indexOf(OSC_START, cursor)
      if (start === -1) {
        if (input.endsWith('\x1b')) {
          this.carry = '\x1b'
        }
        return
      }
      const bel = input.indexOf('\x07', start + 2)
      const st = input.indexOf('\x1b\\', start + 2)
      const end = bel === -1 ? st : st === -1 ? bel : Math.min(bel, st)
      const nested = input.indexOf(OSC_START, start + 2)
      if (nested !== -1 && (end < 0 || nested < end)) {
        cursor = nested
        continue
      }
      if (end < 0) {
        this.carry = input.length - start <= MAX_CARRY ? input.slice(start) : ''
        return
      }
      const payload = input.slice(start + 2, end)
      if (payload === '777;orca-omp-prompt;ready') {
        this.ready = true
      } else if (/^777;orca-omp-prompt;submitted;[a-f0-9]{64}$/.test(payload)) {
        this.ready = false
        this.submittedSequence += 1
        this.submittedFingerprint = payload.slice('777;orca-omp-prompt;submitted;'.length)
      } else if (
        payload === '777;orca-omp-prompt;blocked' ||
        /^[012];omp$/i.test(payload) ||
        /^133;D(?:;|$)/.test(payload)
      ) {
        this.ready = false
      }
      cursor = end + (end === bel ? 1 : 2)
    }
  }
}
