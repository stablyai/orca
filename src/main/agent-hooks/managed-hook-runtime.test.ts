import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveRelayGrokHome } from './managed-hook-runtime'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe.runIf(process.platform !== 'win32')('resolveRelayGrokHome', () => {
  it('uses the login-shell GROK_HOME and normalizes trailing separators', async () => {
    vi.stubEnv('SHELL', '/bin/sh')
    vi.stubEnv('GROK_HOME', '/srv/grok///')

    await expect(resolveRelayGrokHome('/home/orca')).resolves.toBe('/srv/grok')
  })

  it('falls back when the login-shell GROK_HOME is not an absolute POSIX path', async () => {
    vi.stubEnv('SHELL', '/bin/sh')
    vi.stubEnv('GROK_HOME', '../relative')

    await expect(resolveRelayGrokHome('/home/orca')).resolves.toBe('/home/orca/.grok')
  })
})
