import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT } from '../../../shared/terminal/replay/terminal-scrollback-policy'
import {
  DAEMON_SESSION_SCROLLBACK_ROWS,
  resolveDaemonSessionScrollbackRows
} from './daemon-session-scrollback-window'

// N-02: only the cloud VM raises the host's live window; local desktop daemons keep theirs.
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

  it('is raised only where the VM starts orcad', () => {
    const start = readFileSync(
      join(__dirname, '../../../../cloud/apps/sandbox-control/image/vm/orca-sandbox-start'),
      'utf8'
    )
    const orcadLaunch = start.slice(start.lastIndexOf('env -i', start.indexOf('orcad-boot"')))
    expect(orcadLaunch.slice(0, orcadLaunch.indexOf('orcad-boot"'))).toContain(
      `ORCA_DAEMON_SESSION_SCROLLBACK_ROWS=${DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT}`
    )
  })
})
