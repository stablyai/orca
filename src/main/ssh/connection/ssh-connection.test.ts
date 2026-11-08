import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  clientInstances,
  emitSshEvent,
  eventHandlers,
  VALID_ED25519_HOST_KEY,
  ssh2Mock
} from '../__tests__/ssh-connection-test-client'
import { nextSshClientCreation, resetSshConnectionMocks } from './ssh-connection-test-harness'
import { createCallbacks, createTarget } from './ssh-connection-test-fixtures'
import { SshConnection } from './ssh-connection'

vi.mock('../ssh2-module-load', async () =>
  (await import('../__tests__/ssh-connection-test-client')).createSsh2LoaderModule()
)
vi.mock('../system-transport/system-ssh-binary', async () =>
  (await import('./ssh-connection-test-harness')).createSystemSshBinaryModule()
)
vi.mock('../system-transport/system-ssh-args', async (importOriginal) =>
  (await import('./ssh-connection-test-harness')).withSystemSshArgsMocks(await importOriginal())
)
vi.mock('../system-transport/system-ssh-command', async (importOriginal) =>
  (await import('./ssh-connection-test-harness')).withSystemSshCommandMocks(await importOriginal())
)
vi.mock('../system-transport/system-ssh-file-binary-transfer', async (importOriginal) =>
  (await import('./ssh-connection-test-harness')).withSystemSshFileBinaryTransferMocks(
    await importOriginal()
  )
)
vi.mock('../system-transport/system-ssh-file-transfer', async (importOriginal) =>
  (await import('./ssh-connection-test-harness')).withSystemSshFileTransferMocks(
    await importOriginal()
  )
)
vi.mock('../ssh-control-socket', async () =>
  (await import('./ssh-connection-test-harness')).createControlSocketModule()
)
vi.mock('../config/ssh-config-parser', async () =>
  (await import('./ssh-connection-test-harness')).createSshConfigParserModule()
)
vi.mock('../config/ssh-g-config-resolution', async (importOriginal) =>
  (await import('./ssh-connection-test-harness')).withSshGConfigResolutionMocks(
    await importOriginal()
  )
)

describe('SshConnection', () => {
  beforeEach(() => {
    resetSshConnectionMocks()
  })

  it('enables TCP_NODELAY before SSH authentication completes', async () => {
    ssh2Mock.connectSequence = ['silent']
    const conn = new SshConnection(createTarget(), createCallbacks())
    const clientCreated = nextSshClientCreation()
    const connected = conn.connect()
    await clientCreated

    try {
      expect(conn.getState().status).toBe('connecting')
      expect(clientInstances[0].setNoDelay).toHaveBeenCalledWith(true)
    } finally {
      emitSshEvent('ready')
      await connected
      conn.disconnect()
    }
  })

  it('ignores a late host fingerprint from an obsolete connect generation', async () => {
    const conn = new SshConnection(createTarget(), createCallbacks())
    await conn.connect()
    const firstVerifier = (
      clientInstances[0].lastConnectConfig as {
        hostVerifier?: (key: Buffer, verify: (ok: boolean) => void) => undefined
      }
    ).hostVerifier

    const privateConn = conn as unknown as { attemptConnect: () => Promise<void> }
    await privateConn.attemptConnect()
    const secondVerifier = (
      clientInstances[1].lastConnectConfig as {
        hostVerifier?: (key: Buffer, verify: (ok: boolean) => void) => undefined
      }
    ).hostVerifier
    expect(firstVerifier).toBeTypeOf('function')
    expect(secondVerifier).toBeTypeOf('function')

    // Use identifiable key blobs so verification reaches the generation fence.
    const newerKey = Buffer.from(
      'AAAAC3NzaC1lZDI1NTE5AAAAILu7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7',
      'base64'
    )
    secondVerifier?.(newerKey, () => {})
    const currentFingerprint = conn.getHostKeyFingerprint()
    firstVerifier?.(VALID_ED25519_HOST_KEY, () => {})

    expect(conn.getHostKeyFingerprint()).toBe(currentFingerprint)
  })

  it('guards late ssh2 errors emitted while destroying a failed startup client', async () => {
    ssh2Mock.connectBehavior = 'error'
    ssh2Mock.connectErrorMessage = 'Connection lost before handshake'
    ssh2Mock.destroyErrorMessage = 'Connection lost before handshake'
    const callbacks = createCallbacks()
    const conn = new SshConnection(createTarget(), callbacks)

    await expect(conn.connect()).rejects.toThrow('Connection lost before handshake')

    expect(conn.getState().status).toBe('error')
  })

  it('rejects late ssh2 ready after disconnect without resurrecting the connection', async () => {
    const callbacks = createCallbacks()
    const conn = new SshConnection(createTarget(), callbacks)

    const clientCreated = new Promise<void>((resolve) => {
      ssh2Mock.notifyClientCreated = resolve
    })
    const connectResult = conn.connect().catch((error: Error) => error)
    await clientCreated
    expect(clientInstances).toHaveLength(1)
    await conn.disconnect()

    await expect(connectResult).resolves.toMatchObject({
      message: 'SSH connection attempt was cancelled'
    })
    expect(conn.getState()).toMatchObject({ status: 'disconnected', error: null })
    expect(callbacks.onStateChange).not.toHaveBeenCalledWith(
      'target-1',
      expect.objectContaining({ status: 'connected' })
    )
  })

  it('keeps the cancellation outcome when ssh2 reports a late startup error', async () => {
    ssh2Mock.connectBehavior = 'error'
    ssh2Mock.connectErrorMessage = 'Connection lost before handshake'
    const callbacks = createCallbacks()
    const conn = new SshConnection(createTarget(), callbacks)

    const clientCreated = new Promise<void>((resolve) => {
      ssh2Mock.notifyClientCreated = resolve
    })
    const connectResult = conn.connect().catch((error: Error) => error)
    await clientCreated
    expect(clientInstances).toHaveLength(1)
    await conn.disconnect()

    await expect(connectResult).resolves.toMatchObject({
      message: 'SSH connection attempt was cancelled'
    })
    expect(conn.getState()).toMatchObject({ status: 'disconnected', error: null })
    expect(callbacks.onStateChange).not.toHaveBeenCalledWith(
      'target-1',
      expect.objectContaining({ status: 'error' })
    )
  })

  describe('keyboard-interactive MFA', () => {
    it('completes password + keyboard-interactive MFA auth and forwards the prompt', async () => {
      vi.stubEnv('SSH_AUTH_SOCK', '')
      ssh2Mock.connectSequence = [
        new Error('All configured authentication methods failed'),
        'silent'
      ]
      const onCredentialRequest = vi.fn(async (_targetId: string, kind: string) =>
        kind === 'password' ? 'password-123' : '1'
      )
      const conn = new SshConnection(createTarget(), createCallbacks({ onCredentialRequest }))

      const connectPromise = conn.connect()
      await vi.waitFor(() => {
        expect(eventHandlers.get('keyboard-interactive')?.size ?? 0).toBeGreaterThan(0)
        expect(clientInstances).toHaveLength(2)
      })
      const finish = vi.fn()
      emitSshEvent(
        'keyboard-interactive',
        '',
        'Choose a verification method:',
        '',
        [{ prompt: 'Passcode or option (1-2):', echo: true }],
        finish
      )
      await vi.waitFor(() => expect(finish).toHaveBeenCalledWith(['1']))
      emitSshEvent('ready')
      await connectPromise

      expect(conn.getState().status).toBe('connected')
      expect(clientInstances[1].lastConnectConfig).toMatchObject({
        tryKeyboard: true,
        password: 'password-123'
      })
      expect(onCredentialRequest).toHaveBeenCalledWith(
        'target-1',
        'password',
        'example.com',
        undefined,
        expect.any(AbortSignal)
      )
      expect(onCredentialRequest).toHaveBeenCalledWith(
        'target-1',
        'keyboard-interactive',
        'Choose a verification method:\nPasscode or option (1-2):',
        true,
        expect.any(AbortSignal)
      )
    })

    it('auto-answers a keyboard-interactive password prompt with the cached password (echo=false)', async () => {
      vi.stubEnv('SSH_AUTH_SOCK', '')
      ssh2Mock.connectSequence = [
        new Error('All configured authentication methods failed'),
        'silent'
      ]
      const onCredentialRequest = vi.fn(async () => 'password-123')
      const conn = new SshConnection(createTarget(), createCallbacks({ onCredentialRequest }))

      const connectPromise = conn.connect()
      await vi.waitFor(() => {
        expect(eventHandlers.get('keyboard-interactive')?.size ?? 0).toBeGreaterThan(0)
        expect(clientInstances).toHaveLength(2)
      })
      const finish = vi.fn()
      emitSshEvent(
        'keyboard-interactive',
        '',
        '',
        '',
        [{ prompt: 'Password: ', echo: false }],
        finish
      )
      await vi.waitFor(() => expect(finish).toHaveBeenCalledWith(['password-123']))
      emitSshEvent('ready')
      await connectPromise

      expect(conn.getState().status).toBe('connected')
      expect(onCredentialRequest).toHaveBeenCalledTimes(1)
    })

    it('caches a password collected through a keyboard-interactive prompt, but never caches an OTP', async () => {
      vi.stubEnv('SSH_AUTH_SOCK', '')
      ssh2Mock.connectSequence = ['silent']
      const onCredentialRequest = vi.fn(async (_targetId: string, kind: string) =>
        kind === 'password' ? 'password-123' : '654321'
      )
      const conn = new SshConnection(createTarget(), createCallbacks({ onCredentialRequest }))

      const connectPromise = conn.connect()
      await vi.waitFor(() =>
        expect(eventHandlers.get('keyboard-interactive')?.size ?? 0).toBeGreaterThan(0)
      )
      const finish = vi.fn()
      emitSshEvent(
        'keyboard-interactive',
        '',
        '',
        '',
        [
          { prompt: 'Password: ', echo: false },
          { prompt: 'One-time password:', echo: false }
        ],
        finish
      )
      await vi.waitFor(() => expect(finish).toHaveBeenCalledWith(['password-123', '654321']))
      emitSshEvent('ready')
      await connectPromise

      expect(onCredentialRequest).toHaveBeenCalledWith(
        'target-1',
        'password',
        'example.com',
        undefined,
        expect.any(AbortSignal)
      )
      expect(onCredentialRequest).toHaveBeenCalledWith(
        'target-1',
        'keyboard-interactive',
        'One-time password:',
        false,
        expect.any(AbortSignal)
      )
      expect(conn.hasCachedCredential()).toBe(true)

      onCredentialRequest.mockClear()
      ssh2Mock.connectSequence = ['silent']
      const privateConn = conn as unknown as { attemptConnect: () => Promise<void> }
      const reconnectPromise = privateConn.attemptConnect()
      await vi.waitFor(() =>
        expect(eventHandlers.get('keyboard-interactive')?.size ?? 0).toBeGreaterThan(0)
      )
      const finish2 = vi.fn()
      emitSshEvent(
        'keyboard-interactive',
        '',
        '',
        '',
        [{ prompt: 'One-time password:', echo: false }],
        finish2
      )
      await vi.waitFor(() => expect(finish2).toHaveBeenCalledWith(['654321']))
      // OTP-only rounds must always ask; password caching cannot answer them.
      expect(onCredentialRequest).toHaveBeenCalledWith(
        'target-1',
        'keyboard-interactive',
        'One-time password:',
        false,
        expect.any(AbortSignal)
      )
      emitSshEvent('ready')
      await reconnectPromise
    })

    it('re-prompts instead of replaying the cached password on a second keyboard-interactive round', async () => {
      vi.stubEnv('SSH_AUTH_SOCK', '')
      ssh2Mock.connectSequence = ['silent']
      const onCredentialRequest = vi.fn(async () => 'password-123')
      const conn = new SshConnection(createTarget(), createCallbacks({ onCredentialRequest }))

      const connectPromise = conn.connect()
      await vi.waitFor(() =>
        expect(eventHandlers.get('keyboard-interactive')?.size ?? 0).toBeGreaterThan(0)
      )
      const finish = vi.fn()
      emitSshEvent(
        'keyboard-interactive',
        '',
        '',
        '',
        [{ prompt: 'Password: ', echo: false }],
        finish
      )
      await vi.waitFor(() => expect(finish).toHaveBeenCalledWith(['password-123']))
      expect(onCredentialRequest).toHaveBeenCalledTimes(1)

      // A fresh password round means the cached value failed; do not replay it to the prompt cap.
      onCredentialRequest.mockClear()
      const finish2 = vi.fn()
      emitSshEvent(
        'keyboard-interactive',
        '',
        '',
        '',
        [{ prompt: 'Password: ', echo: false }],
        finish2
      )
      await vi.waitFor(() => expect(finish2).toHaveBeenCalledWith(['password-123']))
      expect(onCredentialRequest).toHaveBeenCalledWith(
        'target-1',
        'password',
        'example.com',
        undefined,
        expect.any(AbortSignal)
      )

      emitSshEvent('ready')
      await connectPromise
    })

    it('does not fall back to the password prompt after a cancelled keyboard-interactive prompt', async () => {
      vi.stubEnv('SSH_AUTH_SOCK', '')
      ssh2Mock.connectSequence = ['silent']
      const onCredentialRequest = vi.fn(async () => null)
      const conn = new SshConnection(createTarget(), createCallbacks({ onCredentialRequest }))

      const connectPromise = conn.connect()
      connectPromise.catch(() => {})
      await vi.waitFor(() =>
        expect(eventHandlers.get('keyboard-interactive')?.size ?? 0).toBeGreaterThan(0)
      )
      const finish = vi.fn()
      emitSshEvent(
        'keyboard-interactive',
        '',
        '',
        '',
        [{ prompt: 'Duo passcode:', echo: false }],
        finish
      )
      await vi.waitFor(() => expect(finish).toHaveBeenCalledWith([]))

      await expect(connectPromise).rejects.toThrow('Keyboard-interactive authentication cancelled')
      expect(onCredentialRequest).toHaveBeenCalledTimes(1)
      expect(conn.getState().status).toBe('auth-failed')
    })

    it('does not restore the password cache when a prompt resolves after disconnect', async () => {
      vi.stubEnv('SSH_AUTH_SOCK', '')
      ssh2Mock.connectSequence = ['silent']
      let answer: (value: string) => void = () => {}
      const onCredentialRequest = vi.fn(
        () =>
          new Promise<string>((resolve) => {
            answer = resolve
          })
      )
      const conn = new SshConnection(createTarget(), createCallbacks({ onCredentialRequest }))
      const connecting = conn.connect()
      connecting.catch(() => {})
      await vi.waitFor(() => expect(eventHandlers.has('keyboard-interactive')).toBe(true))
      const finish = vi.fn()
      emitSshEvent(
        'keyboard-interactive',
        '',
        '',
        '',
        [{ prompt: 'Password:', echo: false }],
        finish
      )
      await vi.waitFor(() => expect(onCredentialRequest).toHaveBeenCalledOnce())
      await conn.disconnect()
      answer('obsolete-password')
      await vi.waitFor(() => expect(finish).toHaveBeenCalledWith([]))
      expect(conn.hasCachedCredential()).toBe(false)
      expect(conn.getState().status).toBe('disconnected')
      await expect(connecting).rejects.toThrow()
    })

    it('does not treat a missing credential callback as user cancellation', async () => {
      vi.stubEnv('SSH_AUTH_SOCK', '')
      ssh2Mock.connectSequence = ['silent']
      const conn = new SshConnection(createTarget(), createCallbacks())
      const connecting = conn.connect()
      connecting.catch(() => {})
      await vi.waitFor(() => expect(eventHandlers.has('keyboard-interactive')).toBe(true))
      const finish = vi.fn()
      emitSshEvent('keyboard-interactive', '', '', '', [{ prompt: 'Code:', echo: false }], finish)
      await vi.waitFor(() => expect(finish).toHaveBeenCalledWith([]))
      emitSshEvent('error', new Error('All configured authentication methods failed'))
      await expect(connecting).rejects.toThrow('All configured authentication methods failed')
      conn.disconnect()
    })

    it('fails auth (not cancellation) when the server rejects an incorrect MFA answer', async () => {
      vi.stubEnv('SSH_AUTH_SOCK', '')
      ssh2Mock.connectSequence = [
        'silent',
        new Error('All configured authentication methods failed')
      ]
      const onCredentialRequest = vi.fn(async () => '000000')
      const conn = new SshConnection(createTarget(), createCallbacks({ onCredentialRequest }))

      const connectPromise = conn.connect()
      connectPromise.catch(() => {})
      await vi.waitFor(() =>
        expect(eventHandlers.get('keyboard-interactive')?.size ?? 0).toBeGreaterThan(0)
      )
      const finish = vi.fn()
      emitSshEvent(
        'keyboard-interactive',
        '',
        '',
        '',
        [{ prompt: 'Verification code:', echo: false }],
        finish
      )
      await vi.waitFor(() => expect(finish).toHaveBeenCalledWith(['000000']))
      // Reject an answered OTP through auth failure, distinct from explicit prompt cancellation.
      emitSshEvent('error', new Error('All configured authentication methods failed'))

      await expect(connectPromise).rejects.toThrow('All configured authentication methods failed')
      expect(conn.getState().status).toBe('auth-failed')
    })
  })
})
