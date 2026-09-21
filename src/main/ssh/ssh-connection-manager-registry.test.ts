import { describe, expect, it, vi, beforeEach } from 'vitest'
import { resetSsh2ClientState } from './ssh-connection-test-harness'
import { createCallbacks, createTarget } from './ssh-connection-test-fixtures'
import { SshConnectionManager } from './ssh-connection-manager'

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

describe('SshConnectionManager', () => {
  beforeEach(() => {
    resetSsh2ClientState()
  })

  it('connect creates and stores a connection', async () => {
    const mgr = new SshConnectionManager(createCallbacks())
    const target = createTarget()

    const conn = await mgr.connect(target)
    expect(conn.getState().status).toBe('connected')
    expect(mgr.getConnection(target.id)).toBe(conn)
  })

  it('getState returns connection state', async () => {
    const mgr = new SshConnectionManager(createCallbacks())
    const target = createTarget()

    await mgr.connect(target)
    const state = mgr.getState(target.id)

    expect(state).toBeTruthy()
    expect(state!.status).toBe('connected')
  })

  it('getState returns null for unknown targets', () => {
    const mgr = new SshConnectionManager(createCallbacks())
    expect(mgr.getState('unknown')).toBeNull()
  })

  it('disconnect removes the connection', async () => {
    const mgr = new SshConnectionManager(createCallbacks())
    const target = createTarget()

    await mgr.connect(target)
    await mgr.disconnect(target.id)

    expect(mgr.getConnection(target.id)).toBeUndefined()
  })

  it('disconnect is a no-op for unknown targets', async () => {
    const mgr = new SshConnectionManager(createCallbacks())
    await mgr.disconnect('unknown')
  })

  it('reuses existing connected connection for same target', async () => {
    const mgr = new SshConnectionManager(createCallbacks())
    const target = createTarget()

    const conn1 = await mgr.connect(target)
    const conn2 = await mgr.connect(target)

    expect(conn2).toBe(conn1)
  })

  it('getAllStates returns all connection states', async () => {
    const mgr = new SshConnectionManager(createCallbacks())
    await mgr.connect(createTarget({ id: 'a' }))
    await mgr.connect(createTarget({ id: 'b' }))

    const states = mgr.getAllStates()
    expect(states.size).toBe(2)
    expect(states.get('a')?.status).toBe('connected')
    expect(states.get('b')?.status).toBe('connected')
  })

  it('disconnectAll disconnects all connections', async () => {
    const mgr = new SshConnectionManager(createCallbacks())
    await mgr.connect(createTarget({ id: 'a' }))
    await mgr.connect(createTarget({ id: 'b' }))

    await mgr.disconnectAll()

    expect(mgr.getConnection('a')).toBeUndefined()
    expect(mgr.getConnection('b')).toBeUndefined()
  })
})
