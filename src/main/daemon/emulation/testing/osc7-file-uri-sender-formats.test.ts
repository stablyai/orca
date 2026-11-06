import { describe, expect, it } from 'vitest'
import {
  OSC7_KEEPS_FOLDER,
  OSC7_PARSER_AGREEMENT_CASES
} from '../../../../shared/osc7-parser-agreement-cases'
import { TerminalOscCwdTitleScanner } from '../terminal-osc-cwd-title-scanner'

describe('OSC 7 file URIs both parsers must agree on (daemon side)', () => {
  // Real traffic: the daemon tracks the pane's folder from raw PTY bytes through this scanner.
  it.each(OSC7_PARSER_AGREEMENT_CASES)(
    '$name, through the PTY scanner',
    ({ uri, folder, viaScanner }) => {
      const scanner = new TerminalOscCwdTitleScanner({ pathFlavor: 'posix' })
      scanner.scan('\x1b]7;file:///before\x07')
      scanner.scan(`\x1b]7;${uri}\x07`)
      const kept = viaScanner === OSC7_KEEPS_FOLDER || folder === null
      expect(scanner.cwd).toBe(kept ? '/before' : folder)
    }
  )
})
