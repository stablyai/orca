import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  callMock: vi.fn(),
  runtimeClientConstructorMock: vi.fn(),
  serveOrcaAppMock: vi.fn(),
  getDefaultUserDataPathMock: vi.fn(() => '/tmp/orca-user-data')
}))

vi.mock('../runtime/client', async () => {
  const { createRuntimeClientModuleMock } = await import('../index-test-harness.js')
  return createRuntimeClientModuleMock(mocks)
})

import { main } from '../index'

describe('orca host add', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('ORCA_ENVIRONMENT', '')
    vi.stubEnv('ORCA_PAIRING_CODE', '')
    vi.stubEnv('ORCA_REMOTE_PAIRING', '')
    vi.stubEnv('ORCA_DEV_CLI_INVOCATION', '')
    process.exitCode = 0
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    process.exitCode = 0
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('registers explicit connection options and prints a usable selector without connection details', async () => {
    mocks.callMock.mockResolvedValueOnce({
      ok: true,
      result: { capabilities: ['ssh.target-management.v1'] }
    })
    mocks.callMock.mockResolvedValueOnce({
      id: 'add-1',
      ok: true,
      result: {
        target: {
          id: 'ssh-build',
          label: 'Build box',
          host: '192.0.2.10',
          username: 'dev',
          identityFile: '/keys/build',
          proxyCommand: 'ssh gateway -W %h:%p'
        },
        repoReadoptions: []
      },
      _meta: { runtimeId: 'desktop' }
    })

    await main([
      'host',
      'add',
      '--name',
      'Build box',
      '--hostname',
      '192.0.2.10',
      '--user',
      'dev',
      '--port',
      '2222',
      '--identity-file',
      '/keys/build',
      '--jump-host',
      'bastion',
      '--proxy-command',
      'ssh gateway -W %h:%p',
      '--json'
    ])

    expect(mocks.callMock).toHaveBeenCalledWith('ssh.addTarget', {
      target: {
        label: 'Build box',
        host: '192.0.2.10',
        username: 'dev',
        port: 2222,
        identityFile: '/keys/build',
        jumpHost: 'bastion',
        proxyCommand: 'ssh gateway -W %h:%p'
      }
    })
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0][0])).toEqual({
      id: 'add-1',
      ok: true,
      result: {
        host: { kind: 'ssh', name: 'Build box', id: 'ssh-build', selector: '--host ssh:ssh-build' }
      },
      _meta: { runtimeId: 'desktop' }
    })
  })

  it('refuses an invalid port before attempting registration', async () => {
    await main([
      'host',
      'add',
      '--name',
      'Build box',
      '--hostname',
      '192.0.2.10',
      '--user',
      'dev',
      '--port',
      '65536',
      '--json'
    ])

    expect(JSON.parse(vi.mocked(console.log).mock.calls[0][0])).toMatchObject({
      ok: false,
      error: { code: 'invalid_argument' }
    })
    expect(mocks.callMock).not.toHaveBeenCalled()
  })

  it('refuses a valueless optional key path instead of silently saving without it', async () => {
    await main([
      'host',
      'add',
      '--name',
      'Build box',
      '--hostname',
      '192.0.2.10',
      '--user',
      'dev',
      '--identity-file',
      '--json'
    ])

    expect(JSON.parse(vi.mocked(console.log).mock.calls[0][0])).toMatchObject({
      ok: false,
      error: { code: 'invalid_argument' }
    })
    expect(mocks.callMock).not.toHaveBeenCalled()
  })

  it('refuses an older selected runtime without registering on another machine', async () => {
    vi.stubEnv('ORCA_ENVIRONMENT', 'office')
    mocks.callMock.mockResolvedValueOnce({ ok: true, result: { capabilities: [] } })

    await main([
      'host',
      'add',
      '--name',
      'Build box',
      '--hostname',
      '192.0.2.10',
      '--user',
      'dev',
      '--json'
    ])

    expect(JSON.parse(vi.mocked(console.log).mock.calls[0][0])).toMatchObject({
      ok: false,
      error: { code: 'incompatible_runtime' }
    })
    expect(mocks.callMock).not.toHaveBeenCalledWith('ssh.addTarget', expect.anything())
  })
})
