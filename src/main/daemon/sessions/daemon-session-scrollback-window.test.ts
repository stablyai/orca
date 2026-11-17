import { describe, expect, it } from 'vitest'
import { DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT } from '../../../shared/terminal/replay/terminal-scrollback-policy'
import {
  DAEMON_SESSION_SCROLLBACK_ROWS,
  resolveDaemonSessionScrollbackRows
} from './daemon-session-scrollback-window'

// Only the cloud VM raises the host's live window; local desktop daemons keep theirs. That the VM's
// start script sets it is checked in stablyai/orca-cloud (sandbox-control desktop-parity.test.ts).
describe('daemon session scrollback window', () => {
  it('keeps the local desktop default when nothing overrides it', () => {
    expect(DAEMON_SESSION_SCROLLBACK_ROWS).toBe(1000)
    expect(resolveDaemonSessionScrollbackRows({})).toBe(1000)
  })

  it('accepts the cloud VM window at a local terminal depth, and nothing deeper', () => {
    const vm = { ORCA_DAEMON_SESSION_SCROLLBACK_ROWS: String(DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT) }
    expect(resolveDaemonSessionScrollbackRows(vm)).toBe(5000)
    expect(resolveDaemonSessionScrollbackRows({ ORCA_DAEMON_SESSION_SCROLLBACK_ROWS: '5001' })).toBe(1000)
  })
})
