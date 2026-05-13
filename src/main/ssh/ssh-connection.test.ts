import { describe, expect, it, vi, beforeEach } from 'vitest'
import { Socket } from 'net'

let eventHandlers: Map<string, (...args: unknown[]) => void>
let connectBehavior: 'ready' | 'error' = 'ready'
let connectErrorMessage = ''

type MockSshClient = {
  setNoDelay: ReturnType<typeof vi.fn>
  _sock: Socket | undefined
}
let clientInstances: MockSshClient[] = []

vi.mock('ssh2', () => {
  class MockSshClient {
    setNoDelay = vi.fn()
    // Why: production code reads `client._sock` and checks `instanceof net.Socket`
    // to decide which log line to emit. A real Socket instance lets the test
    // exercise the "enabled" branch instead of the "skipped (proxy socket)" branch.
    _sock: Socket | undefined = new Socket()
    constructor() {
      clientInstances.push(this)
    }
    on(event: string, handler: (...args: unknown[]) => void) {
      eventHandlers?.set(event, handler)
    }
    connect() {
      setTimeout(() => {
        if (connectBehavior === 'error') {
          eventHandlers?.get('error')?.(new Error(connectErrorMessage))
        } else {
          eventHandlers?.get('ready')?.()
        }
      }, 0)
    }
    end() {}
    destroy() {}
    exec() {}
    sftp() {}
  }
  return { Client: MockSshClient }
})

vi.mock('./ssh-system-fallback', () => ({
  spawnSystemSsh: vi.fn().mockReturnValue({
    stdin: {},
    stdout: {},
    stderr: {},
    kill: vi.fn(),
    onExit: vi.fn(),
    pid: 99999
  })
}))

vi.mock('./ssh-config-parser', () => ({
  resolveWithSshG: vi.fn().mockResolvedValue(null)
}))

import { SshConnection, SshConnectionManager, type SshConnectionCallbacks } from './ssh-connection'
import { resolveWithSshG } from './ssh-config-parser'
import type { SshTarget } from '../../shared/ssh-types'

function createTarget(overrides?: Partial<SshTarget>): SshTarget {
  return {
    id: 'target-1',
    label: 'Test Server',
    host: 'example.com',
    port: 22,
    username: 'deploy',
    ...overrides
  }
}

function createCallbacks(overrides?: Partial<SshConnectionCallbacks>): SshConnectionCallbacks {
  return {
    onStateChange: vi.fn(),
    ...overrides
  }
}

describe('SshConnection', () => {
  beforeEach(() => {
    eventHandlers = new Map()
    connectBehavior = 'ready'
    connectErrorMessage = ''
    clientInstances = []
  })

  it('transitions to connected on successful connect', async () => {
    const callbacks = createCallbacks()
    const conn = new SshConnection(createTarget(), callbacks)

    await conn.connect()

    expect(conn.getState().status).toBe('connected')
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
    connectBehavior = 'error'
    connectErrorMessage = 'Connection refused'

    const callbacks = createCallbacks()
    const conn = new SshConnection(createTarget(), callbacks)

    await expect(conn.connect()).rejects.toThrow('Connection refused')
    expect(conn.getState().status).toBe('error')
  })

  it('disconnect cleans up and sets state to disconnected', async () => {
    const callbacks = createCallbacks()
    const conn = new SshConnection(createTarget(), callbacks)
    await conn.connect()

    await conn.disconnect()

    expect(conn.getState().status).toBe('disconnected')
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
})

describe('SshConnectionManager', () => {
  beforeEach(() => {
    eventHandlers = new Map()
    connectBehavior = 'ready'
    connectErrorMessage = ''
    clientInstances = []
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
