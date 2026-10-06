import { afterEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { restoreManagedDataAccountEnvironment } from '../../shared/managed-data-account-environment'
import { createDaemonPtyEnvironment } from '../daemon/pty-subprocess/spawn-environment'
import type * as ServiceModule from './service'

const selected = vi.hoisted(() => {
  const value: Record<string, string> = {}
  return { value }
})
vi.mock('./service', async (importOriginal) => {
  const actual = await importOriginal<typeof ServiceModule>()
  const service = new actual.ManagedDataAccountService('test-managed-root')
  vi.spyOn(service, 'launchEnvironment').mockImplementation(() => selected.value)
  return { ...actual, getManagedDataAccountService: () => service }
})
import { applyManagedDataAccountEnvironment } from './launch-environment'
import { getManagedDataAccountService } from './service'

function inheritedProfile(): Record<string, string> {
  const env = {
    XDG_DATA_HOME: join(tmpdir(), 'user-data'),
    OPENCODE_DB: 'user.db',
    OPENCODE_AUTH_CONTENT: 'user-config'
  }
  getManagedDataAccountService().captureOriginalEnvironment(env, {
    XDG_DATA_HOME: join(tmpdir(), 'old-account', 'data'),
    XDG_STATE_HOME: join(tmpdir(), 'old-account', 'state'),
    OPENCODE_AUTH_CONTENT: ''
  })
  return {
    ...env,
    XDG_DATA_HOME: join(tmpdir(), 'old-account', 'data'),
    XDG_STATE_HOME: join(tmpdir(), 'old-account', 'state'),
    OPENCODE_DB: 'opencode.db',
    OPENCODE_AUTH_CONTENT: '',
    ORCA_DATA_ACCOUNT_DATA_HOME: join(tmpdir(), 'old-account', 'data'),
    ORCA_DATA_ACCOUNT_STATE_HOME: join(tmpdir(), 'old-account', 'state'),
    ORCA_DATA_ACCOUNT_PROVIDER: 'opencode'
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
  selected.value = {}
})

describe('managed account inherited environment', () => {
  it.each([
    { launchAgent: 'opencode' as const },
    { launchAgent: 'claude' as const },
    { launchAgent: 'opencode' as const, isWsl: true }
  ])('restores user defaults before eligibility and system selection: %o', (options) => {
    const env = inheritedProfile()
    for (const [key, value] of Object.entries(env)) {
      vi.stubEnv(key, value)
    }
    applyManagedDataAccountEnvironment(env, options)
    expect(env.XDG_DATA_HOME).toBe(join(tmpdir(), 'user-data'))
    expect(env.XDG_STATE_HOME).toBeUndefined()
    expect(env.OPENCODE_DB).toBe('user.db')
    expect(env.OPENCODE_AUTH_CONTENT).toBe('user-config')
    expect(Object.keys(env).some((key) => key.startsWith('ORCA_DATA_ACCOUNT'))).toBe(false)
    const final = createDaemonPtyEnvironment({ sessionId: 'test', cols: 80, rows: 24, env })
    expect(final.XDG_DATA_HOME).toBe(join(tmpdir(), 'user-data'))
    expect(final.XDG_STATE_HOME).toBeUndefined()
    expect(final.ORCA_DATA_ACCOUNT_DATA_HOME).toBeUndefined()
  })

  it('keeps a fresh selection after the daemon restores its own parent profile', () => {
    for (const [key, value] of Object.entries(inheritedProfile())) {
      vi.stubEnv(key, value)
    }
    selected.value = {
      XDG_DATA_HOME: join(tmpdir(), 'new-account', 'data'),
      XDG_STATE_HOME: join(tmpdir(), 'new-account', 'state'),
      OPENCODE_DB: 'opencode.db',
      OPENCODE_AUTH_CONTENT: ''
    }
    const env: Record<string, string> = {}
    applyManagedDataAccountEnvironment(env, { launchAgent: 'opencode' })
    const final = createDaemonPtyEnvironment({ sessionId: 'test', cols: 80, rows: 24, env })
    expect(final.XDG_DATA_HOME).toBe(selected.value.XDG_DATA_HOME)
    restoreManagedDataAccountEnvironment(final)
    expect(final.XDG_DATA_HOME).toBe(join(tmpdir(), 'user-data'))
    expect(final.OPENCODE_DB).toBe('user.db')
  })

  it('scrubs client-owned profile paths without restoring desktop paths on a relay', () => {
    const env = inheritedProfile()
    restoreManagedDataAccountEnvironment(env, false)
    expect(env.XDG_DATA_HOME).toBeUndefined()
    expect(env.XDG_STATE_HOME).toBeUndefined()
    expect(env.OPENCODE_DB).toBeUndefined()
    expect(Object.keys(env).some((key) => key.startsWith('ORCA_DATA_ACCOUNT'))).toBe(false)
  })
})
