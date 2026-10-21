import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isStartupDiagnosticsEnabled,
  logStartupDiagnostic,
  logStartupMilestone,
  STARTUP_DIAGNOSTICS_ENV,
  writeStartupDiagnosticLine
} from './startup-diagnostics'

afterEach(() => vi.unstubAllEnvs())

it('does not compute lazy milestone details unless diagnostics are enabled', () => {
  vi.stubEnv(STARTUP_DIAGNOSTICS_ENV, '0')
  const details = vi.fn(() => ({ bytes: 123 }))
  logStartupMilestone('persistence-load-done', details)
  expect(details).not.toHaveBeenCalled()
  vi.stubEnv(STARTUP_DIAGNOSTICS_ENV, '1')
  logStartupMilestone('persistence-load-done', details)
  expect(details).toHaveBeenCalledOnce()
})

describe('writeStartupDiagnosticLine', () => {
  it('writes directly to stderr fd 2 with a newline', () => {
    const write = vi.fn()

    writeStartupDiagnosticLine('[startup] test', write)

    expect(write).toHaveBeenCalledWith(2, '[startup] test\n')
  })
})

describe('isStartupDiagnosticsEnabled', () => {
  it('requires an explicit opt-in env flag', () => {
    expect(isStartupDiagnosticsEnabled({ [STARTUP_DIAGNOSTICS_ENV]: '1' })).toBe(true)
    expect(isStartupDiagnosticsEnabled({ [STARTUP_DIAGNOSTICS_ENV]: 'true' })).toBe(false)
    expect(isStartupDiagnosticsEnabled({})).toBe(false)
  })
})

describe('logStartupDiagnostic', () => {
  it('formats event details as a synchronous startup diagnostic line', () => {
    const write = vi.fn()

    logStartupDiagnostic('before-lock', { packaged: true, userData: '/tmp/orca' }, write)

    expect(write).toHaveBeenCalledWith(
      2,
      '[startup] before-lock packaged=true userData="/tmp/orca"\n'
    )
  })
})
