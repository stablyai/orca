import { extractLastOscTitle } from '../../shared/agent-detection'
import { parseFileUriPath } from './osc7-file-uri'
import { extractOscScanTail, scanOsc7Uris } from './osc7-uri-extraction'

const OSC_SCAN_TAIL_LIMIT = 4096

/** Mirror of the OSC sequences the emulator tracks outside xterm: OSC 7 cwd
 *  updates and OSC 0/2 titles. Keeps an unterminated-sequence tail so
 *  sequences split across PTY chunks still parse. Uses the bounded regex-free
 *  scanners so giant pasted chunks stay cheap. */
export type TerminalOscCwdTitleScannerOptions = {
  pathFlavor?: 'posix' | 'win32'
  remotePosixAuthority?: boolean
  wslDistro?: string
}

export class TerminalOscCwdTitleScanner {
  private scanTail = ''
  private readonly parseOptions: TerminalOscCwdTitleScannerOptions
  cwd: string | null = null
  lastTitle: string | null = null

  constructor(options: TerminalOscCwdTitleScannerOptions = {}) {
    this.parseOptions = options
  }

  scan(data: string): void {
    // Why the pre-filter: this runs on the daemon's per-chunk hot path; flood
    // chunks with no OSC introducer must not pay the title/URI walks
    // (measured share of a 2.2x ingest regression — findings log 2026-07-03).
    // Correctness across splits: an OSC intro spanning chunks either left a
    // non-empty scanTail or this chunk ends with a bare ESC, which
    // extractOscScanTail retains for the next call.
    if (this.scanTail.length === 0 && !data.includes('\x1b]')) {
      this.scanTail = data.endsWith('\x1b') ? extractOscScanTail(data, OSC_SCAN_TAIL_LIMIT) : ''
      return
    }
    const input = this.scanTail.length === 0 ? data : this.scanTail + data
    this.scanTail = extractOscScanTail(input, OSC_SCAN_TAIL_LIMIT)
    scanOsc7Uris(input, (uri) => {
      const parsed = parseFileUriPath(uri, {
        pathFlavor: this.parseOptions.pathFlavor,
        remotePosixAuthority: this.parseOptions.remotePosixAuthority,
        wslDistro: this.parseOptions.wslDistro
      })
      if (parsed) {
        this.cwd = parsed
      }
    })
    const lastTitle = extractLastOscTitle(input)
    if (lastTitle !== null) {
      this.lastTitle = lastTitle
    }
  }
}
