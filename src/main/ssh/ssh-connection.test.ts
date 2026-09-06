import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  clientInstances,
  createSsh2Module,
  emitSshEvent,
  eventHandlers,
  resetSshConnectionMocks,
  VALID_ED25519_HOST_KEY,
  ssh2Mock
} from './ssh-connection-test-harness'
import { createCallbacks, createTarget } from './ssh-connection-test-fixtures'
import { SshConnection } from './ssh-connection'

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

  it('transitions to connected on successful connect', async () => {
    const callbacks = createCallbacks()
    const conn = new SshConnection(createTarget(), callbacks)

    await conn.connect()

    expect(conn.getState().status).toBe('connected')
    expect(conn.getState().supportsFolderDownload).toBe(true)
    expect(callbacks.onStateChange).toHaveBeenCalledWith(
      'target-1',
      expect.objectContaining({ status: 'connected' })
    )
  })

  it('enables TCP_NODELAY on the ssh2 client after ready', async () => {
    const conn = new SshConnection(createTarget(), createCallbacks())
    await conn.connect()

    expect(clientInstances).toHaveLength(1)
    expect(clientInstances[0].setNoDelay).toHaveBeenCalledWith(true)
  })

  it('captures the negotiated SSH server key fingerprint', async () => {
    const conn = new SshConnection(createTarget(), createCallbacks())
    await conn.connect()

    expect(conn.getHostKeyFingerprint()).toMatch(/^SHA256:[A-Za-z\d+/]{43}$/)
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

    // Real blobs: the verifier now identifies the key before recording a fingerprint, so a
    // placeholder string would be refused before it could reach the generation check this covers.
    const newerKey = Buffer.from(
      'AAAAC3NzaC1lZDI1NTE5AAAAILu7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7',
      'base64'
    )
    secondVerifier?.(newerKey, () => {})
    const currentFingerprint = conn.getHostKeyFingerprint()
    firstVerifier?.(VALID_ED25519_HOST_KEY, () => {})

    expect(conn.getHostKeyFingerprint()).toBe(currentFingerprint)
  })

  it('allows concurrent exec commands for ssh2 transport', async () => {
    const conn = new SshConnection(createTarget(), createCallbacks())
    await conn.connect()

    expect(conn.usesSystemSshTransport()).toBe(false)
    expect(conn.canRunConcurrentExecCommands()).toBe(true)
  })

  it('removes startup listeners after ssh2 connect succeeds', async () => {
    const conn = new SshConnection(createTarget(), createCallbacks())

    await conn.connect()

    expect(eventHandlers.has('ready')).toBe(false)
    // The remaining error listener is the steady-state disconnect handler.
    expect(eventHandlers.has('error')).toBe(true)
  })

  it('scopes lifecycle events and pending handshake timers to one mock client', async () => {
    vi.useFakeTimers()
    try {
      const { Client } = createSsh2Module()
      const first = new Client()
      const second = new Client()
      const firstClose = vi.fn()
      const secondClose = vi.fn()
      const firstError = vi.fn()
      first.on('close', firstClose)
      first.on('error', firstError)
      second.on('close', secondClose)

      first.emit('close')
      expect(firstClose).toHaveBeenCalledOnce()
      expect(secondClose).not.toHaveBeenCalled()

      ssh2Mock.connectBehavior = 'pending'
      first.connect({ readyTimeout: 1_000 })
      await vi.advanceTimersByTimeAsync(0)
      first.destroy()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(firstError).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('enables TCP_NODELAY on the new ssh2 client after a reconnect cycle', async () => {
    // Why: guards the "Nagle is re-enabled because someone refactored only
    // the initial connect path" regression class. attemptConnect bumps
    // connectGeneration on every call, and both the initial connect and the
    // explicit reconnect path go through doSsh2Connect → client.on('ready').
    // The new client must also receive setNoDelay(true).
    const conn = new SshConnection(createTarget(), createCallbacks())
    await conn.connect()
    expect(clientInstances).toHaveLength(1)
    expect(clientInstances[0].setNoDelay).toHaveBeenCalledWith(true)

    // Simulate the reconnect path: a fresh attemptConnect run via the
    // internal helper that scheduleReconnect uses. Easiest from the public
    // API is to call connect() again — disposed/connected guard rejects, so
    // we exercise the path via a private call. Use the bracket-access
    // form to keep the test free of `any` casts.
    const privateConn = conn as unknown as {
      attemptConnect: () => Promise<void>
    }
    await privateConn.attemptConnect()

    expect(clientInstances).toHaveLength(2)
    expect(clientInstances[1].setNoDelay).toHaveBeenCalledWith(true)
  })

  it('transitions through connecting → connected states', async () => {
    const states: string[] = []
    const callbacks = createCallbacks({
      onStateChange: vi.fn((_id, state) => states.push(state.status))
    })
    const conn = new SshConnection(createTarget(), callbacks)

    await conn.connect()

    expect(states).toContain('connecting')
    expect(states).toContain('connected')
  })

  it('reports error state on connection failure', async () => {
    ssh2Mock.connectBehavior = 'error'
    ssh2Mock.connectErrorMessage = 'Connection refused'

    const callbacks = createCallbacks()
    const conn = new SshConnection(createTarget(), callbacks)

    await expect(conn.connect()).rejects.toThrow('Connection refused')
    expect(conn.getState().status).toBe('error')
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

  it('disconnect cleans up and sets state to disconnected', async () => {
    const callbacks = createCallbacks()
    const conn = new SshConnection(createTarget(), callbacks)
    await conn.connect()

    await conn.disconnect()

    expect(conn.getState().status).toBe('disconnected')
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

  it('getTarget returns a copy of the target', () => {
    const target = createTarget()
    const conn = new SshConnection(target, createCallbacks())
    const returned = conn.getTarget()

    expect(returned).toEqual(target)
    expect(returned).not.toBe(target)
  })

  it('getState returns a copy of the state', () => {
    const conn = new SshConnection(createTarget(), createCallbacks())
    const state1 = conn.getState()
    const state2 = conn.getState()

    expect(state1).toEqual(state2)
    expect(state1).not.toBe(state2)
  })

  it('throws when connecting a disposed connection', async () => {
    const conn = new SshConnection(createTarget(), createCallbacks())
    await conn.disconnect()

    await expect(conn.connect()).rejects.toThrow('Connection disposed')
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
      const retryConfig = clientInstances[1].lastConnectConfig as {
        password?: string
        tryKeyboard?: boolean
      }
      expect(retryConfig.tryKeyboard).toBe(true)
      expect(retryConfig.password).toBe('password-123')
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

      // Reconnect: the OTP prompt must be asked again (never auto-answered from a cache).
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
      // Why not answered from the password cache: this round only sends the
      // OTP prompt (no password-looking prompt), so it must reach the user
      // as a fresh 'keyboard-interactive' request every time.
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

      // The server rejected that password and opened a new round for it. Auto-answering from the
      // cache again would replay the rejected value up to the round cap without asking the user.
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

      // Why no server error event: a cancelled prompt now fails the attempt
      // immediately instead of waiting on a server round-trip that will
      // never come from a user decision.
      await expect(connectPromise).rejects.toThrow('Keyboard-interactive authentication cancelled')
      expect(onCredentialRequest).toHaveBeenCalledTimes(1)
      expect(conn.getState().status).toBe('auth-failed')
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
      // Why the second connectSequence entry is a plain error rather than
      // another keyboard-interactive round: an incorrect OTP is a distinct
      // case from cancellation — the user DID answer, the server rejected
      // it — so this must not go through the keyboardInteractiveCancelled
      // short-circuit at all.
      emitSshEvent('error', new Error('All configured authentication methods failed'))

      await expect(connectPromise).rejects.toThrow('All configured authentication methods failed')
      expect(conn.getState().status).toBe('auth-failed')
    })
  })
})
