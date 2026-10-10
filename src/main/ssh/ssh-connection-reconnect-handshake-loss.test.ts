import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  advanceToNextSshClient,
  clientInstances,
  connectWithFakeTimers,
  emitSshEvent,
  resetSshConnectionMocks,
  ssh2Mock
} from './ssh-connection-test-harness'
import { createCallbacks, createTarget } from './ssh-connection-test-fixtures'
import { SshConnection } from './ssh-connection'
import { CONNECT_TIMEOUT_MS, RECONNECT_BACKOFF_MS } from './ssh-connection-utils'

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

// ssh2's exact shape when TCP connects but the socket closes before the server banner.
const preBannerLoss = (): Error =>
  Object.assign(new Error('Connection lost before handshake'), { level: 'protocol' })

async function connectedTarget(statuses: string[]): Promise<SshConnection> {
  const conn = new SshConnection(
    createTarget(),
    createCallbacks({ onStateChange: vi.fn((_id, state) => statuses.push(state.status)) })
  )
  await connectWithFakeTimers(conn)
  return conn
}

describe('SshConnection reconnect after a network outage', () => {
  beforeEach(() => {
    resetSshConnectionMocks()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('schedules a backoff retry when the reconnect loses the socket before the banner', async () => {
    const statuses: string[] = []
    const conn = await connectedTarget(statuses)
    ssh2Mock.connectSequence = [preBannerLoss(), 'ready']

    emitSshEvent('close')
    await advanceToNextSshClient(RECONNECT_BACKOFF_MS[0])

    // Shipped published 'error' with reconnectAttempt 0 here and never retried.
    expect(conn.getState()).toMatchObject({ status: 'reconnecting', reconnectAttempt: 1 })
    expect(statuses).not.toContain('error')

    await advanceToNextSshClient(RECONNECT_BACKOFF_MS[1])
    expect(conn.getState().status).toBe('connected')
    expect(clientInstances).toHaveLength(3)
  })

  it('keeps retrying through a 45s outage of repeated pre-banner losses', async () => {
    const statuses: string[] = []
    const conn = await connectedTarget(statuses)
    ssh2Mock.connectSequence = [preBannerLoss(), preBannerLoss(), preBannerLoss(), 'ready']

    emitSshEvent('close')
    for (const delayMs of RECONNECT_BACKOFF_MS.slice(0, 4)) {
      await advanceToNextSshClient(delayMs)
    }

    expect(conn.getState().status).toBe('connected')
    expect(statuses).not.toContain('error')
    expect(statuses).not.toContain('reconnection-failed')
  })

  it.each([
    ['the socket closes during key exchange', 'close'],
    ['the handshake watchdog fires', 'watchdog'],
    ['the server resets the connection', 'reset']
  ] as const)('schedules a backoff retry when %s', async (_label, phase) => {
    const statuses: string[] = []
    const conn = await connectedTarget(statuses)
    ssh2Mock.connectSequence =
      phase === 'reset'
        ? [Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }), 'ready']
        : ['silent', 'ready']

    emitSshEvent('close')
    await advanceToNextSshClient(RECONNECT_BACKOFF_MS[0])
    if (phase === 'close') {
      emitSshEvent('close')
      await vi.advanceTimersByTimeAsync(0)
    } else if (phase === 'watchdog') {
      await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS)
    }

    expect(conn.getState().status).toBe('reconnecting')
    await advanceToNextSshClient(RECONNECT_BACKOFF_MS[1])
    expect(conn.getState().status).toBe('connected')
    expect(statuses).not.toContain('error')
  })

  it('stops retrying once the user disconnects mid-outage', async () => {
    const statuses: string[] = []
    const conn = await connectedTarget(statuses)
    ssh2Mock.connectSequence = [preBannerLoss()]

    emitSshEvent('close')
    await advanceToNextSshClient(RECONNECT_BACKOFF_MS[0])
    expect(conn.getState().status).toBe('reconnecting')

    await conn.disconnect()
    const clientsAfterDisconnect = clientInstances.length
    await vi.advanceTimersByTimeAsync(RECONNECT_BACKOFF_MS.at(-1)! * 2)

    expect(conn.getState().status).toBe('disconnected')
    expect(clientInstances).toHaveLength(clientsAfterDisconnect)
  })
})
