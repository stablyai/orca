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

  it('disconnectAll preserves excluded reset connections in the registry', async () => {
    const mgr = new SshConnectionManager(createCallbacks())
    const retained = await mgr.connect(createTarget({ id: 'reset' }))
    await mgr.connect(createTarget({ id: 'ordinary' }))
    const disconnect = vi.spyOn(retained, 'disconnect')
    await mgr.disconnectAll((id) => id !== 'reset')
    expect(disconnect).not.toHaveBeenCalled()
    expect(mgr.getConnection('reset')).toBe(retained)
    expect(mgr.getConnection('ordinary')).toBeUndefined()
    await mgr.disconnectAll()
  })

  it('checks disconnect admission immediately before each transport effect', async () => {
    const mgr = new SshConnectionManager(createCallbacks())
    const first = await mgr.connect(createTarget({ id: 'first' }))
    const second = await mgr.connect(createTarget({ id: 'second' }))
    const disconnectSecond = vi.spyOn(second, 'disconnect')
    let reserved = false
    const originalDisconnect = first.disconnect.bind(first)
    vi.spyOn(first, 'disconnect').mockImplementation(() => {
      reserved = true
      return originalDisconnect()
    })
    await mgr.disconnectAll((id) => id !== 'second' || !reserved)
    expect(disconnectSecond).not.toHaveBeenCalled()
    expect(mgr.getConnection('second')).toBe(second)
    await mgr.disconnectAll()
  })

  it('does not erase a replacement registered while an admitted disconnect settles', async () => {
    const mgr = new SshConnectionManager(createCallbacks())
    const target = createTarget({ id: 'target' })
    const old = await mgr.connect(target)
    const state = old.getState()
    vi.spyOn(old, 'getState').mockReturnValue({ ...state, status: 'disconnected' })
    let finish!: () => void
    vi.spyOn(old, 'disconnect')
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve
          })
      )
      .mockResolvedValue(undefined)
    const drain = mgr.disconnectAll()
    const replacement = await mgr.connect(target)
    expect(replacement).not.toBe(old)
    finish()
    await drain
    expect(mgr.getConnection('target')).toBe(replacement)
    await mgr.disconnectAll()
  })
})
