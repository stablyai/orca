import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  advanceToNextSshClient,
  connectWithFakeTimers,
  nextSshClientCreation,
  resetSshConnectionMocks,
  spawnSystemSshCommandMock
} from './ssh-connection-test-harness'
import { clientInstances, emitSshEvent, ssh2Mock } from '../__tests__/ssh-connection-test-client'
import {
  createCallbacks,
  createHangingSystemCommandChannel,
  createResolvedConfig,
  createTarget
} from './ssh-connection-test-fixtures'
import { SshConnection } from './ssh-connection'
import { resolveWithSshG } from '../config/ssh-g-config-resolution'
import { SshConnectionManager } from './ssh-connection-manager'
import { RECONNECT_BACKOFF_MS } from './ssh-connection-timing'
import { recordSshUserDisconnected, resetSshUserDisconnectsForTests } from '../ssh-user-disconnect'

vi.mock('ssh2', async () =>
  (await import('../__tests__/ssh-connection-test-client')).createSsh2Module()
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

function failHandshakes(): void {
  ssh2Mock.connectBehavior = 'error'
  ssh2Mock.connectErrorMessage = 'connect ETIMEDOUT 10.0.0.5:22'
  ssh2Mock.connectErrorCode = 'ETIMEDOUT'
}

function recordStatuses(): { statuses: string[]; conn: SshConnection } {
  const statuses: string[] = []
  const conn = new SshConnection(
    createTarget(),
    createCallbacks({ onStateChange: vi.fn((_id, state) => statuses.push(state.status)) })
  )
  return { statuses, conn }
}

async function spendLadderWhileAsleep(conn: SshConnection): Promise<void> {
  failHandshakes()
  emitSshEvent('close')
  for (const delayMs of RECONNECT_BACKOFF_MS) {
    await advanceToNextSshClient(delayMs)
  }
  expect(conn.getState().status).toBe('reconnection-failed')
}

describe('SshConnection retry after wake or network return', () => {
  beforeEach(() => {
    resetSshConnectionMocks()
    resetSshUserDisconnectsForTests()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('retries a host the ladder gave up on while the machine slept (#26888)', async () => {
    const { conn } = recordStatuses()
    await connectWithFakeTimers(conn)
    await spendLadderWhileAsleep(conn)
    const clientsBefore = clientInstances.length

    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(clientInstances).toHaveLength(clientsBefore)

    ssh2Mock.connectBehavior = 'ready'
    const created = nextSshClientCreation()
    expect(conn.retryAfterNetworkReturn()).toBe(true)
    await created
    await vi.advanceTimersByTimeAsync(1)

    expect(conn.getState().status).toBe('connected')
  })

  it('gives a wake retry the full failure budget, not what the dark wakes left', async () => {
    const { conn } = recordStatuses()
    await connectWithFakeTimers(conn)
    await spendLadderWhileAsleep(conn)

    // The network is still coming back: the wake attempt fails and the ladder must start afresh.
    const created = nextSshClientCreation()
    conn.retryAfterNetworkReturn()
    await created
    await vi.advanceTimersByTimeAsync(1)
    expect(conn.getState().status).toBe('reconnecting')

    ssh2Mock.connectBehavior = 'ready'
    await advanceToNextSshClient(RECONNECT_BACKOFF_MS[0])
    expect(conn.getState().status).toBe('connected')
  })

  it('skips the backoff a reconnect is waiting on', async () => {
    const { conn } = recordStatuses()
    await connectWithFakeTimers(conn)
    failHandshakes()
    emitSshEvent('close')
    for (const delayMs of RECONNECT_BACKOFF_MS.slice(0, 7)) {
      await advanceToNextSshClient(delayMs)
    }
    expect(conn.getState().status).toBe('reconnecting')

    ssh2Mock.connectBehavior = 'ready'
    const created = nextSshClientCreation()
    expect(conn.retryAfterNetworkReturn()).toBe(true)
    await created
    await vi.advanceTimersByTimeAsync(1)
    expect(conn.getState().status).toBe('connected')
  })

  it('replaces a background handshake left hanging on the route from before sleep', async () => {
    const { conn } = recordStatuses()
    await connectWithFakeTimers(conn)
    ssh2Mock.connectBehavior = 'pending'
    emitSshEvent('close')
    await advanceToNextSshClient(RECONNECT_BACKOFF_MS[0])
    expect(conn.getState().status).toBe('connecting')

    expect(conn.retryAfterNetworkReturn()).toBe(false)

    await vi.advanceTimersByTimeAsync(10_000)
    ssh2Mock.connectBehavior = 'ready'
    const created = nextSshClientCreation()
    expect(conn.retryAfterNetworkReturn()).toBe(true)
    await created
    await vi.advanceTimersByTimeAsync(1)
    expect(conn.getState().status).toBe('connected')
  })

  it("keeps the replacement's system-SSH transport when the superseded probe closes late", async () => {
    vi.mocked(resolveWithSshG).mockResolvedValue(createResolvedConfig())
    const conn = new SshConnection(createTarget(), createCallbacks())
    await conn.connect()
    expect(conn.usesSystemSshTransport()).toBe(true)

    const stale = createHangingSystemCommandChannel()
    spawnSystemSshCommandMock.mockImplementationOnce(() => stale)
    void conn.reconnect()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(conn.getState().status).toBe('connecting')

    expect(conn.retryAfterNetworkReturn()).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(conn.getState().status).toBe('connected')

    // System-channel close can arrive after its replacement; stale cleanup must not overwrite it.
    stale.emit('close', null)
    await vi.advanceTimersByTimeAsync(1)
    expect(conn.getState().status).toBe('connected')
    expect(conn.usesSystemSshTransport()).toBe(true)
  })

  it('leaves healthy, initial, and explicitly closed connections alone', async () => {
    const { conn } = recordStatuses()
    await connectWithFakeTimers(conn)
    expect(conn.retryAfterNetworkReturn()).toBe(false)

    await conn.disconnect()
    expect(conn.retryAfterNetworkReturn()).toBe(false)

    const initial = new SshConnection(createTarget(), createCallbacks())
    ssh2Mock.connectBehavior = 'pending'
    void initial.connect().catch(() => undefined)
    await vi.advanceTimersByTimeAsync(10_000)
    // The first connect owns its own retries and result.
    expect(initial.retryAfterNetworkReturn()).toBe(false)
    await initial.disconnect()
  })

  it('restarts every stalled connection the manager holds', async () => {
    const manager = new SshConnectionManager(createCallbacks())
    const created = nextSshClientCreation()
    const connecting = manager.connect(createTarget())
    await created
    await vi.advanceTimersByTimeAsync(1)
    const conn = await connecting
    await spendLadderWhileAsleep(conn)

    ssh2Mock.connectBehavior = 'ready'
    const recreated = nextSshClientCreation()
    expect(manager.retryStalledReconnects()).toEqual([createTarget().id])
    await recreated
    await vi.advanceTimersByTimeAsync(1)
    expect(manager.getState(createTarget().id)?.status).toBe('connected')
    expect(manager.retryStalledReconnects()).toEqual([])
    await manager.disconnectAll()
  })

  it('never redials a host the user disconnected while its teardown is still queued', async () => {
    const { conn } = recordStatuses()
    await connectWithFakeTimers(conn)
    // A drop already waiting on its backoff when the user presses Disconnect.
    failHandshakes()
    emitSshEvent('close')
    expect(conn.getState().status).toBe('reconnecting')
    recordSshUserDisconnected(createTarget().id)
    ssh2Mock.connectBehavior = 'ready'
    const clientsBefore = clientInstances.length

    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(conn.retryAfterNetworkReturn()).toBe(false)
    await conn.reconnect()
    expect(clientInstances).toHaveLength(clientsBefore)

    await conn.disconnect()
  })
})
