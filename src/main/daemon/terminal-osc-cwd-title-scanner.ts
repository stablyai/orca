import { extractLastOscTitle } from '../../shared/agent-detection'
import { parseFileUriPath } from './osc7-file-uri'
import { extractOscScanTail, scanOsc7Uris } from './osc7-uri-extraction'

const OSC_SCAN_TAIL_LIMIT = 4096

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
    // Skip scans on plain output while retaining a trailing ESC for a split OSC introducer.
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
