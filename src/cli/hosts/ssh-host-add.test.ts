import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RuntimeClient } from '../runtime/client'
import { main } from '../index'

describe('orca host add', () => {
  const callMock = vi.fn()

  beforeEach(() => {
    callMock.mockReset()
    vi.spyOn(RuntimeClient.prototype, 'call').mockImplementation(callMock)
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

  it.each([
    { portArgs: ['--port', '2222'], expectedPort: 2222 },
    { portArgs: [], expectedPort: 22 }
  ])(
    'registers connection options with port $expectedPort and prints a redacted selector',
    async ({ portArgs, expectedPort }) => {
      callMock.mockResolvedValueOnce({
        ok: true,
        result: { capabilities: ['ssh.target-management.v1'] }
      })
      callMock.mockResolvedValueOnce({
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
        ...portArgs,
        '--identity-file',
        '/keys/build',
        '--jump-host',
        'bastion',
        '--proxy-command',
        'ssh gateway -W %h:%p',
        '--json'
      ])

      expect(callMock).toHaveBeenCalledWith('ssh.addTarget', {
        target: {
          label: 'Build box',
          host: '192.0.2.10',
          username: 'dev',
          port: expectedPort,
          identityFile: '/keys/build',
          jumpHost: 'bastion',
          proxyCommand: 'ssh gateway -W %h:%p'
        }
      })
      expect(JSON.parse(vi.mocked(console.log).mock.calls[0][0])).toEqual({
        id: 'add-1',
        ok: true,
        result: {
          host: {
            kind: 'ssh',
            name: 'Build box',
            id: 'ssh-build',
            selector: '--host ssh:ssh-build'
          }
        },
        _meta: { runtimeId: 'desktop' }
      })
    }
  )

  it.each([
    { portArgs: ['--port', '65536'] },
    { portArgs: ['--port='] },
    { portArgs: ['--port', ''] }
  ])('refuses invalid port arguments $portArgs before either RPC', async ({ portArgs }) => {
    await main([
      'host',
      'add',
      '--name',
      'Build box',
      '--hostname',
      '192.0.2.10',
      '--user',
      'dev',
      ...portArgs,
      '--json'
    ])

    expect(JSON.parse(vi.mocked(console.log).mock.calls[0][0])).toMatchObject({
      ok: false,
      error: { code: 'invalid_argument', message: expect.stringContaining('--port') }
    })
    expect(callMock).not.toHaveBeenCalled()
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
      error: { code: 'invalid_argument', message: expect.stringContaining('--identity-file') }
    })
    expect(callMock).not.toHaveBeenCalled()
  })

  it('refuses an older selected runtime without registering on another machine', async () => {
    vi.stubEnv('ORCA_ENVIRONMENT', 'office')
    callMock.mockResolvedValueOnce({ ok: true, result: { capabilities: [] } })

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
    expect(callMock).not.toHaveBeenCalledWith('ssh.addTarget', expect.anything())
  })
})
