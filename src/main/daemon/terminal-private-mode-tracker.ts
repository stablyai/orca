import type { TerminalModes } from './types'

// Why: PTY/SSH chunks can split a long combined DECSET before the final h/l.
// Keep parser state far beyond normal mode lists while still bounding memory.
const PRIVATE_MODE_SCAN_TAIL_LIMIT = 4096

type MouseTrackingMode = NonNullable<TerminalModes['mouseTrackingMode']>

// Why: @xterm/headless doesn't expose DECSET mouse/SGR encoding state, so the
// emulator mirrors it by scanning the raw byte stream; snapshots restore these
// modes on rehydrate.
export class TerminalPrivateModeTracker {
  private scanTail = ''
  mouseTrackingMode: MouseTrackingMode = 'none'
  sgrMouseMode = false
  sgrMousePixelsMode = false

  scan(data: string): void {
    const input = this.scanTail + data
    this.scanTail = this.extractScanTail(input)
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

  private extractScanTail(input: string): string {
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
      return this.isIncompleteParams(tail.slice(3)) ? tail : ''
    }
    if (tail.startsWith('\x9b?')) {
      return this.isIncompleteParams(tail.slice(2)) ? tail : ''
    }
    return ''
  }

  private isIncompleteParams(params: string): boolean {
    return /^[0-9;]*$/.test(params)
  }
}
