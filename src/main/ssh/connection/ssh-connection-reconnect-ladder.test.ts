import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  advanceToNextSshClient,
  connectWithFakeTimers,
  nextSshClientCreation,
  resetSshConnectionMocks,
  spawnSystemSshCommandMock
} from './ssh-connection-test-harness'
import {
  clientInstances,
  connectAttempts,
  emitSshEvent,
  ssh2Mock
} from '../__tests__/ssh-connection-test-client'
import {
  createCallbacks,
  createHangingSystemCommandChannel,
  createResolvedConfig,
  createTarget
} from './ssh-connection-test-fixtures'
import { SshConnection } from './ssh-connection'
import { resolveWithSshG } from '../config/ssh-g-config-resolution'
import { CONNECT_TIMEOUT_MS, RECONNECT_BACKOFF_MS } from './ssh-connection-timing'
import { MIN_SSH_RELAY_GRACE_PERIOD_SECONDS } from '../../../shared/ssh-types'

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

  it('forces a fresh SSH connection for an explicit reconnect', async () => {
    const states: string[] = []
    const conn = new SshConnection(
      createTarget(),
      createCallbacks({
        onStateChange: vi.fn((_id, state) => states.push(state.status))
      })
    )
    await conn.connect()

    await conn.reconnect()

    expect(clientInstances).toHaveLength(2)
    expect(states).toEqual(['connecting', 'connected', 'reconnecting', 'connecting', 'connected'])
    expect(conn.getState().status).toBe('connected')
  })

  it('escalates the backoff across repeated post-handshake drops', async () => {
    vi.useFakeTimers()
    try {
      const conn = new SshConnection(createTarget(), createCallbacks())
      await connectWithFakeTimers(conn)
      expect(clientInstances).toHaveLength(1)

      emitSshEvent('close')
      await vi.advanceTimersByTimeAsync(999)
      expect(clientInstances).toHaveLength(1)
      await advanceToNextSshClient(1)
      expect(clientInstances).toHaveLength(2)

      // Separate delay progression from failure count so post-handshake drops cannot stay at the1s rung.
      emitSshEvent('close')
      await vi.advanceTimersByTimeAsync(1999)
      expect(clientInstances).toHaveLength(2)
      await advanceToNextSshClient(1)
      expect(clientInstances).toHaveLength(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('publishes reconnectAttempt=0 on the reconnected state and the escalating step while reconnecting', async () => {
    vi.useFakeTimers()
    try {
      const published: { status: string; reconnectAttempt: number }[] = []
      const conn = new SshConnection(
        createTarget(),
        createCallbacks({
          onStateChange: vi.fn((_id, state) =>
            published.push({ status: state.status, reconnectAttempt: state.reconnectAttempt })
          )
        })
      )
      await connectWithFakeTimers(conn)

      for (let drop = 0; drop < 3; drop++) {
        emitSshEvent('close')
        await advanceToNextSshClient(30_000)
      }

      expect(
        published.filter((e) => e.status === 'reconnecting').map((e) => e.reconnectAttempt)
      ).toEqual([0, 1, 2])
      // src/main/ipc/ssh/ssh.ts gates the relay redeploy on reconnectAttempt === 0 at 'connected'.
      expect(
        published.filter((e) => e.status === 'connected').map((e) => e.reconnectAttempt)
      ).toEqual([0, 0, 0, 0])
    } finally {
      vi.useRealTimers()
    }
  })

  it('restarts the ladder at the head when an explicit reconnect fails', async () => {
    // Explicit retries reset the ladder and consume no step; their first failure stays at0/1000ms.
    vi.useFakeTimers()
    try {
      const published: { status: string; reconnectAttempt: number }[] = []
      const conn = new SshConnection(
        createTarget(),
        createCallbacks({
          onStateChange: vi.fn((_id, state) =>
            published.push({ status: state.status, reconnectAttempt: state.reconnectAttempt })
          )
        })
      )
      await connectWithFakeTimers(conn)

      ssh2Mock.connectBehavior = 'error'
      ssh2Mock.connectErrorMessage = 'connect ETIMEDOUT 10.0.0.5:22'
      ssh2Mock.connectErrorCode = 'ETIMEDOUT'
      published.length = 0
      const clientCreated = nextSshClientCreation()
      const reconnected = conn.reconnect()
      await clientCreated
      await vi.advanceTimersByTimeAsync(1)
      await reconnected

      expect(
        published.filter((e) => e.status === 'reconnecting').map((e) => e.reconnectAttempt)
      ).toEqual([0, 0])
    } finally {
      vi.useRealTimers()
    }
  })

  it('reaches reconnection-failed after 9 consecutive handshake failures', async () => {
    vi.useFakeTimers()
    try {
      const statuses: string[] = []
      const conn = new SshConnection(
        createTarget(),
        createCallbacks({
          onStateChange: vi.fn((_id, state) => statuses.push(state.status))
        })
      )
      await connectWithFakeTimers(conn)

      ssh2Mock.connectBehavior = 'error'
      ssh2Mock.connectErrorMessage = 'connect ETIMEDOUT 10.0.0.5:22'
      ssh2Mock.connectErrorCode = 'ETIMEDOUT'
      emitSshEvent('close')
      for (const delayMs of RECONNECT_BACKOFF_MS) {
        await advanceToNextSshClient(delayMs)
      }

      expect(statuses).toContain('reconnection-failed')
      // Enforce exactly the initial attempt plus the configured retry budget.
      expect(connectAttempts).toBe(1 + RECONNECT_BACKOFF_MS.length)
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries a saturated flap streak while the remote relay is still in grace', async () => {
    vi.useFakeTimers()
    try {
      const conn = new SshConnection(createTarget(), createCallbacks())
      await connectWithFakeTimers(conn)

      // Repeated short-lived successful handshakes saturate backoff without consuming failure budget.
      for (let drop = 0; drop < 12; drop++) {
        emitSshEvent('close')
        await advanceToNextSshClient(45_000)
      }
      expect(conn.getState().status).toBe('connected')

      const before = clientInstances.length
      emitSshEvent('close')
      // Retry plus worst-case handshake must fit the shortest relay grace or remote PTYs are destroyed.
      await advanceToNextSshClient(
        MIN_SSH_RELAY_GRACE_PERIOD_SECONDS * 1000 - CONNECT_TIMEOUT_MS - 1
      )
      expect(clientInstances.length).toBeGreaterThan(before)
    } finally {
      vi.useRealTimers()
    }
  })

  it('logs the delay ladder position separately from the failure streak', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const conn = new SshConnection(createTarget(), createCallbacks())
      await connectWithFakeTimers(conn)

      for (let drop = 0; drop < 12; drop++) {
        emitSshEvent('close')
        await advanceToNextSshClient(45_000)
      }

      const lastReconnectLog = warn.mock.calls
        .map((call) => String(call[0]))
        .findLast((line) => line.includes('Reconnecting to'))
      // A saturated flap ladder must not read like the connection is one step from giving up.
      expect(lastReconnectLog).toContain('delay step 9/9')
      expect(lastReconnectLog).toContain('failed handshakes 0/9')
    } finally {
      warn.mockRestore()
      vi.useRealTimers()
    }
  })

  it('keeps retrying when a flap streak is followed by one handshake failure', async () => {
    vi.useFakeTimers()
    try {
      const statuses: string[] = []
      const conn = new SshConnection(
        createTarget(),
        createCallbacks({
          onStateChange: vi.fn((_id, state) => statuses.push(state.status))
        })
      )
      await connectWithFakeTimers(conn)

      // 12 flaps saturate the delay ladder without ever touching the failure streak.
      for (let drop = 0; drop < 12; drop++) {
        emitSshEvent('close')
        await advanceToNextSshClient(30_000)
      }
      ssh2Mock.connectSequence = [new Error('connect ETIMEDOUT 10.0.0.5:22')]
      emitSshEvent('close')
      await advanceToNextSshClient(30_000)
      await advanceToNextSshClient(30_000)

      expect(statuses).not.toContain('reconnection-failed')
      expect(conn.getState().status).toBe('connected')
    } finally {
      vi.useRealTimers()
    }
  })

  it('recovers the same owner after a temporary DNS resolution failure', async () => {
    vi.useFakeTimers()
    try {
      const states: string[] = []
      const conn = new SshConnection(
        createTarget(),
        createCallbacks({
          onStateChange: vi.fn((_id, state) => states.push(state.status))
        })
      )
      await connectWithFakeTimers(conn)
      const connectedGeneration = conn.getConnectGeneration()
      const dnsFailure = Object.assign(
        new Error('getaddrinfo EAI_AGAIN temporary failure in name resolution'),
        { code: 'EAI_AGAIN' }
      )
      ssh2Mock.connectSequence = [dnsFailure, 'ready']

      emitSshEvent('close')
      await advanceToNextSshClient(RECONNECT_BACKOFF_MS[0])

      expect(conn.getState().status).toBe('reconnecting')
      expect(states).not.toContain('error')
      expect(states).not.toContain('reconnection-failed')

      await advanceToNextSshClient(RECONNECT_BACKOFF_MS[1])

      expect(conn.getState().status).toBe('connected')
      expect(conn.getConnectGeneration()).toBeGreaterThan(connectedGeneration)
      expect(clientInstances).toHaveLength(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a system-transport target on the ladder after a probe timeout', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(resolveWithSshG).mockResolvedValue(createResolvedConfig())
      const statuses: string[] = []
      const conn = new SshConnection(
        createTarget(),
        createCallbacks({
          onStateChange: vi.fn((_id, state) => statuses.push(state.status))
        })
      )
      await conn.connect()
      expect(conn.usesSystemSshTransport()).toBe(true)

      // The probe times out with OpenSSH prose, not an errno the transient code table matches.
      spawnSystemSshCommandMock.mockImplementation(() => createHangingSystemCommandChannel())
      statuses.length = 0
      const reconnected = conn.reconnect()
      await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS)
      await reconnected

      expect(statuses).not.toContain('error')
      expect(conn.getState().status).toBe('reconnecting')

      const probesBefore = spawnSystemSshCommandMock.mock.calls.length
      await vi.advanceTimersByTimeAsync(RECONNECT_BACKOFF_MS[0])
      expect(spawnSystemSshCommandMock.mock.calls.length).toBeGreaterThan(probesBefore)
    } finally {
      vi.useRealTimers()
    }
  })

  it('publishes no cancellation error when a connect supersedes a parked ladder attempt', async () => {
    const published: { status: string; error?: string }[] = []
    let releaseParked: (() => void) | null = null
    vi.mocked(resolveWithSshG).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseParked = () => resolve(null)
        })
    )
    const conn = new SshConnection(
      createTarget(),
      createCallbacks({
        onStateChange: vi.fn((_id, state) => published.push({ status: state.status, ...state }))
      })
    )

    // Park automatic reconnect in ssh -G while the user starts a new connection.
    const parked = conn.reconnect()
    await conn.connect()
    releaseParked!()
    await parked

    expect(conn.getState().status).toBe('connected')
    expect(published.filter((entry) => entry.status === 'error')).toEqual([])
    expect(published.map((entry) => entry.error).filter(Boolean)).toEqual([])
  })

  it('rejects a superseded connect without publishing a permanent error', async () => {
    const published: string[] = []
    let releaseParked: (() => void) | null = null
    vi.mocked(resolveWithSshG).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseParked = () => resolve(null)
        })
    )
    const conn = new SshConnection(
      createTarget(),
      createCallbacks({
        onStateChange: vi.fn((_id, state) => published.push(state.status))
      })
    )

    const superseded = conn.connect()
    await conn.connect()
    releaseParked!()

    await expect(superseded).rejects.toThrow('SSH connection attempt was cancelled')
    expect(conn.getState().status).toBe('connected')
    expect(published).not.toContain('error')
  })
})
