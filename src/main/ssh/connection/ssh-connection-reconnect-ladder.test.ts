import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  advanceToNextSshClient,
  connectWithFakeTimers,
  resetSshConnectionMocks
} from './ssh-connection-test-harness'
import { clientInstances, emitSshEvent, ssh2Mock } from '../__tests__/ssh-connection-test-client'
import { createCallbacks, createTarget } from './ssh-connection-test-fixtures'
import { SshConnection } from './ssh-connection'
import { resolveWithSshG } from '../config/ssh-g-config-resolution'
import { RECONNECT_BACKOFF_MS } from './ssh-connection-timing'
import '../../../shared/ssh-types'

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
