import { afterEach, expect, it, vi } from 'vitest'
import { logStartupMilestone, STARTUP_DIAGNOSTICS_ENV } from './startup-diagnostics'

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
