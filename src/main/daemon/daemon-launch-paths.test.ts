import { afterEach, describe, expect, it } from 'vitest'
import { daemonDiagnosticsDisabled, daemonLogArgs } from './daemon-launch-paths'

const original = process.env.ORCA_DIAGNOSTICS_DISABLED

afterEach(() => {
  if (original === undefined) {
    delete process.env.ORCA_DIAGNOSTICS_DISABLED
  } else {
    process.env.ORCA_DIAGNOSTICS_DISABLED = original
  }
})

describe('daemonDiagnosticsDisabled', () => {
  it('honors the documented truthy spellings, including padding and case', () => {
    for (const value of ['1', 'true', 'TRUE', '  true  ']) {
      process.env.ORCA_DIAGNOSTICS_DISABLED = value
      expect(daemonDiagnosticsDisabled(), value).toBe(true)
    }
  })

  it('stays enabled for unset, empty, and non-truthy values', () => {
    delete process.env.ORCA_DIAGNOSTICS_DISABLED
    expect(daemonDiagnosticsDisabled()).toBe(false)
    for (const value of ['', '0', 'false', 'yes']) {
      process.env.ORCA_DIAGNOSTICS_DISABLED = value
      expect(daemonDiagnosticsDisabled(), value).toBe(false)
    }
  })

  // Why: both the launch args and the post-startup exit record gate on this
  // switch, so a regression here writes diagnostics a user opted out of.
  it('drops the daemon log-file argument when diagnostics are disabled', () => {
    process.env.ORCA_DIAGNOSTICS_DISABLED = 'true'
    expect(daemonLogArgs()).toEqual([])
    process.env.ORCA_DIAGNOSTICS_DISABLED = '0'
    expect(daemonLogArgs()).toEqual(['--log-file', expect.any(String)])
  })
})
