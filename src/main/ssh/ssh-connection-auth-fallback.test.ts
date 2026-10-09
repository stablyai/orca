import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  clientInstances,
  emitSshEvent,
  nextSshClientCreation,
  resetSshConnectionMocks,
  ssh2Mock
} from './ssh-connection-test-harness'
import { createCallbacks, createTarget } from './ssh-connection-test-fixtures'
import { SshConnection } from './ssh-connection'
import { resolveWithSshG } from './ssh-config-parser'

vi.mock('ssh2', async () => (await import('./ssh-connection-test-harness')).createSsh2Module())
vi.mock('./system-ssh-binary', async () =>
  (await import('./ssh-connection-test-harness')).createSystemSshBinaryModule()
)
vi.mock('./ssh-system-fallback', async () =>
  (await import('./ssh-connection-test-harness')).createSystemFallbackModule()
)
vi.mock('./ssh-control-socket', async () =>
  (await import('./ssh-connection-test-harness')).createControlSocketModule()
)
vi.mock('./ssh-config-parser', async () =>
  (await import('./ssh-connection-test-harness')).createSshConfigParserModule()
)

describe('SshConnection', () => {
  beforeEach(() => {
    resetSshConnectionMocks()
  })

  it('resolves OpenSSH config using configHost when present', async () => {
    const callbacks = createCallbacks()
    const conn = new SshConnection(
      createTarget({
        label: 'Friendly Name',
        configHost: 'ssh-alias'
      }),
      callbacks
    )

    await conn.connect()

    expect(resolveWithSshG).toHaveBeenCalledWith('ssh-alias')
  })

  it('answers bounded keyboard-interactive challenges such as Duo 2FA', async () => {
    vi.useFakeTimers()
    const onCredentialRequest = vi.fn().mockResolvedValueOnce('1').mockResolvedValueOnce('123456')
    try {
      const conn = new SshConnection(createTarget(), createCallbacks({ onCredentialRequest }))
      const clientCreated = nextSshClientCreation()
      const connected = conn.connect()
      await clientCreated
      const finish = vi.fn()

      emitSshEvent(
        'keyboard-interactive',
        'Duo two-factor login',
        'Select push or enter a passcode.',
        '',
        [
          { prompt: 'Option:', echo: false },
          { prompt: 'Passcode:', echo: false }
        ],
        finish
      )
      for (let turn = 0; turn < 20 && finish.mock.calls.length === 0; turn += 1) {
        await Promise.resolve()
      }

      expect(clientInstances[0].lastConnectConfig).toMatchObject({ tryKeyboard: true })
      expect(onCredentialRequest).toHaveBeenNthCalledWith(
        1,
        'target-1',
        'keyboard-interactive',
        'Duo two-factor login\nSelect push or enter a passcode.\nOption:',
        false,
        expect.any(AbortSignal)
      )
      expect(onCredentialRequest).toHaveBeenNthCalledWith(
        2,
        'target-1',
        'keyboard-interactive',
        'Duo two-factor login\nSelect push or enter a passcode.\nPasscode:',
        false,
        expect.any(AbortSignal)
      )
      expect(finish).toHaveBeenCalledWith(['1', '123456'])

      await vi.advanceTimersByTimeAsync(1)
      await connected
    } finally {
      vi.useRealTimers()
    }
  })

  it('rearms the handshake budget for each slow prompt in one keyboard-interactive round', async () => {
    vi.useFakeTimers()
    ssh2Mock.connectBehavior = 'pending'
    const firstResponse = Promise.withResolvers<string | null>()
    const secondResponse = Promise.withResolvers<string | null>()
    const onCredentialRequest = vi
      .fn()
      .mockImplementationOnce(() => firstResponse.promise)
      .mockImplementationOnce(() => secondResponse.promise)
    try {
      const conn = new SshConnection(createTarget(), createCallbacks({ onCredentialRequest }))
      const clientCreated = nextSshClientCreation()
      const connected = conn.connect()
      let settled = false
      void connected.then(
        () => {
          settled = true
        },
        () => {
          settled = true
        }
      )
      await clientCreated
      await vi.advanceTimersByTimeAsync(1)
      const finish = vi.fn()
      emitSshEvent(
        'keyboard-interactive',
        'Duo two-factor login',
        'Complete both checks.',
        '',
        [
          { prompt: 'Option:', echo: false },
          { prompt: 'Passcode:', echo: false }
        ],
        finish
      )

      await vi.advanceTimersByTimeAsync(100_000)
      firstResponse.resolve('1')
      for (let turn = 0; turn < 20 && onCredentialRequest.mock.calls.length < 2; turn += 1) {
        await Promise.resolve()
      }
      expect(onCredentialRequest).toHaveBeenCalledTimes(2)

      await vi.advanceTimersByTimeAsync(30_000)
      expect(settled).toBe(false)
      expect(finish).not.toHaveBeenCalled()

      secondResponse.resolve('123456')
      for (let turn = 0; turn < 20 && finish.mock.calls.length === 0; turn += 1) {
        await Promise.resolve()
      }
      expect(finish).toHaveBeenCalledWith(['1', '123456'])
      emitSshEvent('ready')
      await connected
    } finally {
      vi.useRealTimers()
    }
  })

  it('aborts an in-flight keyboard challenge when the connection is disconnected', async () => {
    vi.useFakeTimers()
    ssh2Mock.connectBehavior = 'pending'
    let credentialSignal: AbortSignal | undefined
    const onCredentialRequest = vi.fn(
      (
        _targetId: string,
        _kind: string,
        _detail: string,
        _echo?: boolean,
        signal?: AbortSignal
      ) => {
        credentialSignal = signal
        const response = Promise.withResolvers<string | null>()
        if (signal?.aborted) {
          response.resolve(null)
        } else {
          signal?.addEventListener('abort', () => response.resolve(null), { once: true })
        }
        return response.promise
      }
    )
    try {
      const conn = new SshConnection(createTarget(), createCallbacks({ onCredentialRequest }))
      const clientCreated = nextSshClientCreation()
      const connected = conn.connect()
      const connectionResult = connected.then(
        () => null,
        (error: unknown) => error
      )
      await clientCreated
      await vi.advanceTimersByTimeAsync(1)
      const finish = vi.fn()
      emitSshEvent(
        'keyboard-interactive',
        'Duo two-factor login',
        'Approve the push.',
        '',
        [{ prompt: 'Response:', echo: false }],
        finish
      )
      await Promise.resolve()
      expect(credentialSignal?.aborted).toBe(false)

      await conn.disconnect()
      expect(credentialSignal?.aborted).toBe(true)
      await expect(connectionResult).resolves.toBeInstanceOf(Error)
      for (let turn = 0; turn < 4 && finish.mock.calls.length === 0; turn += 1) {
        await Promise.resolve()
      }
      expect(finish).toHaveBeenCalledWith([])
    } finally {
      vi.useRealTimers()
    }
  })
})
