import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_COMPATIBILITY_HOST_KIND_ENV } from '../shared/orchestration-compatibility-evidence'

const mocks = vi.hoisted(() => ({
  callMock: vi.fn(),
  runtimeClientConstructorMock: vi.fn(),
  serveOrcaAppMock: vi.fn(),
  getDefaultUserDataPathMock: vi.fn()
}))
vi.mock('./runtime-client', async () => {
  const { createRuntimeClientModuleMock } = await import('./index-test-harness.js')
  return createRuntimeClientModuleMock(mocks)
})

import { main } from './index'
import { okFixture } from './test-fixtures'
import { RuntimeRpcFailureError } from './runtime/types'

const routingEnv = [
  'ORCA_ENVIRONMENT',
  'ORCA_PAIRING_CODE',
  'ORCA_REMOTE_PAIRING',
  'ORCA_CLI_CWD',
  ORCHESTRATION_COMPATIBILITY_HOST_KIND_ENV
]

describe('runtime-access CLI', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    for (const key of routingEnv) {
      vi.stubEnv(key, undefined)
    }
    process.exitCode = 0
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    process.exitCode = 0
  })

  it('lists from the local runtime and preserves its identity in JSON', async () => {
    const result = okFixture('list', { grants: [] })
    mocks.callMock.mockResolvedValue(result)
    await main(['runtime-access', 'list', '--json'])
    expect(process.exitCode).toBe(0)
    expect(mocks.runtimeClientConstructorMock).toHaveBeenCalledWith(null, null)
    expect(mocks.callMock).toHaveBeenCalledWith('runtimeAccess.list')
    expect(JSON.parse(String(vi.mocked(console.log).mock.calls[0][0]))).toEqual(result)
  })

  it('escapes grant names in human-readable output', async () => {
    mocks.callMock.mockResolvedValue(
      okFixture('list', {
        grants: [
          { deviceId: 'id', name: '\u001b[2J\nforged\u009b2J', createdAt: 1, lastSeenAt: null }
        ]
      })
    )
    await main(['runtime-access', 'list'])
    const output = String(vi.mocked(console.log).mock.calls[0][0])
    expect(output).not.toContain('\u001b')
    expect(output).not.toContain('\u009b')
    expect(output).toContain('"\\u001b[2J\\nforged\\u009b2J"')
    expect(output).toContain('Runtime: runtime-1')
  })

  it.each(['environment', 'pairing-code', 'host'])(
    'rejects explicit --%s without an RPC',
    async (flag) => {
      await main(['runtime-access', 'revoke', '--device', 'id', `--${flag}`, 'remote', '--json'])
      expect(process.exitCode).toBe(1)
      expect(mocks.callMock).not.toHaveBeenCalled()
    }
  )

  it.each(routingEnv)('rejects ambient or forwarded %s without an RPC', async (key) => {
    vi.stubEnv(key, key === ORCHESTRATION_COMPATIBILITY_HOST_KIND_ENV ? 'ssh' : 'remote')
    await main(['runtime-access', 'list', '--json'])
    expect(process.exitCode).toBe(1)
    expect(mocks.callMock).not.toHaveBeenCalled()
  })

  it('rejects an empty forwarded cwd as well', async () => {
    vi.stubEnv('ORCA_CLI_CWD', '')
    await main(['runtime-access', 'revoke', '--device', 'id', '--json'])
    expect(process.exitCode).toBe(1)
    expect(mocks.callMock).not.toHaveBeenCalled()
  })

  it('rejects forwarded commands despite a pre-command selector parser difference', async () => {
    vi.stubEnv('ORCA_CLI_CWD', '/remote')
    await main(['--environment', 'runtime-access', 'list', '--json'])
    expect(process.exitCode).toBe(1)
    expect(mocks.callMock).not.toHaveBeenCalled()
  })

  it.each([{ args: [] }, { args: ['--device'] }])(
    'requires an explicit device value ($args)',
    async ({ args }) => {
      await main(['runtime-access', 'revoke', ...args, '--json'])
      expect(process.exitCode).toBe(1)
      expect(mocks.callMock).not.toHaveBeenCalled()
    }
  )

  it('revokes only the supplied grant', async () => {
    mocks.callMock.mockResolvedValue(okFixture('revoke', { revoked: true }))
    await main([
      'runtime-access',
      'revoke',
      '--device',
      '00000000-0000-4000-8000-000000000000',
      '--json'
    ])
    expect(process.exitCode).toBe(0)
    expect(mocks.callMock).toHaveBeenCalledExactlyOnceWith('runtimeAccess.revoke', {
      deviceId: '00000000-0000-4000-8000-000000000000'
    })
  })

  it.each(['runtime_access_not_found', 'runtime_error'])('exits nonzero on %s', async (code) => {
    mocks.callMock.mockRejectedValue(
      new RuntimeRpcFailureError({
        id: 'failed',
        ok: false,
        error: { code, message: 'Revocation failed' },
        _meta: { runtimeId: 'fixture' }
      })
    )
    await main(['runtime-access', 'revoke', '--device', 'id', '--json'])
    expect(process.exitCode).toBe(1)
    expect(JSON.parse(String(vi.mocked(console.log).mock.calls[0][0]))).toMatchObject({
      ok: false,
      error: { code }
    })
  })
})
