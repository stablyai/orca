import { EventEmitter } from 'events'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { SshPortForwardManager } from './ssh-port-forward'

const { spawnSystemSshPortForwardMock } = vi.hoisted(() => ({
  spawnSystemSshPortForwardMock: vi.fn()
}))

vi.mock('./ssh-system-fallback', () => ({
  spawnSystemSshPortForward: spawnSystemSshPortForwardMock
}))

function createMockConn(forwardOutErr?: Error) {
  const mockChannel = {
    pipe: vi.fn().mockReturnThis(),
    on: vi.fn(),
    close: vi.fn()
  }
  const mockClient = {
    forwardOut: vi.fn().mockImplementation((_bindAddr, _bindPort, _destHost, _destPort, cb) => {
      if (forwardOutErr) {
        cb(forwardOutErr, null)
      } else {
        cb(null, mockChannel)
      }
    })
  }
  return {
    getClient: vi.fn().mockReturnValue(mockClient),
    usesSystemSshTransport: vi.fn().mockReturnValue(false),
    mockClient,
    mockChannel
  }
}

function createSystemSshConn() {
  return {
    getClient: vi.fn().mockReturnValue(null),
    usesSystemSshTransport: vi.fn().mockReturnValue(true),
    getTarget: vi.fn().mockReturnValue({
      id: 'target-1',
      label: 'container',
      host: 'container',
      port: 22,
      username: 'vscode'
    })
  }
}

function createFakeSystemSshProcess() {
  const process = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter
    kill: ReturnType<typeof vi.fn>
    exitCode: number | null
    signalCode: NodeJS.Signals | null
  }
  process.stderr = new EventEmitter()
  process.kill = vi.fn()
  process.exitCode = null
  process.signalCode = null
  return process
}

// Mock the net module to avoid real TCP listeners
vi.mock('net', () => {
  const listeners = new Map<string, (...args: unknown[]) => void>()
  return {
    createServer: vi.fn().mockImplementation((connectionHandler) => {
      const server = {
        listen: vi.fn().mockImplementation((_port, _host, cb) => cb()),
        close: vi.fn(),
        on: vi.fn().mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
          listeners.set(event, handler)
        }),
        removeListener: vi.fn(),
        _connectionHandler: connectionHandler,
        _listeners: listeners
      }
      return server
    })
  }
})

describe('SshPortForwardManager', () => {
  let manager: SshPortForwardManager

  beforeEach(() => {
    manager = new SshPortForwardManager()
    spawnSystemSshPortForwardMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('adds a port forward and returns entry', async () => {
    const conn = createMockConn()
    const entry = await manager.addForward('conn-1', conn as never, 3000, 'localhost', 8080)

    expect(entry).toMatchObject({
      connectionId: 'conn-1',
      localPort: 3000,
      remoteHost: 'localhost',
      remotePort: 8080
    })
    expect(entry.id).toBeDefined()
  })

  it('throws when SSH client is not connected', async () => {
    const conn = {
      getClient: vi.fn().mockReturnValue(null),
      usesSystemSshTransport: vi.fn().mockReturnValue(false)
    }
    await expect(
      manager.addForward('conn-1', conn as never, 3000, 'localhost', 8080)
    ).rejects.toThrow('SSH connection is not established')
  })

  it('adds a system SSH port forward when no ssh2 client is available', async () => {
    vi.useFakeTimers()
    const process = createFakeSystemSshProcess()
    spawnSystemSshPortForwardMock.mockReturnValue(process)
    const conn = createSystemSshConn()

    const pending = manager.addForward('conn-1', conn as never, 3000, '127.0.0.1', 8080)
    await vi.advanceTimersByTimeAsync(250)
    const entry = await pending

    expect(spawnSystemSshPortForwardMock).toHaveBeenCalledWith(
      conn.getTarget(),
      3000,
      '127.0.0.1',
      8080
    )
    expect(entry).toMatchObject({
      connectionId: 'conn-1',
      localPort: 3000,
      remoteHost: '127.0.0.1',
      remotePort: 8080
    })
    expect(manager.listForwards('conn-1')).toHaveLength(1)
  })

  it('surfaces early system SSH port forward failures', async () => {
    vi.useFakeTimers()
    const process = createFakeSystemSshProcess()
    spawnSystemSshPortForwardMock.mockReturnValue(process)
    const conn = createSystemSshConn()

    const pending = manager.addForward('conn-1', conn as never, 3000, '127.0.0.1', 8080)
    process.stderr.emit('data', Buffer.from('bind: Address already in use'))
    process.emit('exit', 255)

    await expect(pending).rejects.toThrow('bind: Address already in use')
    expect(manager.listForwards('conn-1')).toHaveLength(0)
  })

  it('kills a system SSH tunnel when removing the forward', async () => {
    vi.useFakeTimers()
    const process = createFakeSystemSshProcess()
    spawnSystemSshPortForwardMock.mockReturnValue(process)
    const conn = createSystemSshConn()

    const pending = manager.addForward('conn-1', conn as never, 3000, '127.0.0.1', 8080)
    await vi.advanceTimersByTimeAsync(250)
    const entry = await pending

    expect(manager.removeForward(entry.id)).toMatchObject({ id: entry.id })
    expect(process.kill).toHaveBeenCalledWith('SIGTERM')
    expect(manager.listForwards('conn-1')).toHaveLength(0)
  })

  it('waits for system SSH tunnels to exit before async removal resolves', async () => {
    vi.useFakeTimers()
    const process = createFakeSystemSshProcess()
    spawnSystemSshPortForwardMock.mockReturnValue(process)
    const conn = createSystemSshConn()

    const pending = manager.addForward('conn-1', conn as never, 3000, '127.0.0.1', 8080)
    await vi.advanceTimersByTimeAsync(250)
    await pending

    let resolved = false
    const removal = manager.removeAllForwards('conn-1').then(() => {
      resolved = true
    })

    await vi.advanceTimersByTimeAsync(1_999)
    expect(process.kill).toHaveBeenCalledWith('SIGTERM')
    expect(resolved).toBe(false)

    process.emit('exit', null)
    await removal
    expect(resolved).toBe(true)
  })

  it('escalates stuck system SSH tunnels to SIGKILL before async removal resolves', async () => {
    vi.useFakeTimers()
    const process = createFakeSystemSshProcess()
    spawnSystemSshPortForwardMock.mockReturnValue(process)
    const conn = createSystemSshConn()

    const pending = manager.addForward('conn-1', conn as never, 3000, '127.0.0.1', 8080)
    await vi.advanceTimersByTimeAsync(250)
    await pending

    let resolved = false
    const removal = manager.removeAllForwards('conn-1').then(() => {
      resolved = true
    })

    await vi.advanceTimersByTimeAsync(2_000)
    expect(process.kill).toHaveBeenNthCalledWith(1, 'SIGTERM')
    expect(process.kill).toHaveBeenNthCalledWith(2, 'SIGKILL')
    expect(resolved).toBe(false)

    process.emit('exit', null)
    await removal
    expect(resolved).toBe(true)
  })

  it('lists forwards filtered by connectionId', async () => {
    const conn = createMockConn()
    await manager.addForward('conn-1', conn as never, 3000, 'localhost', 8080)
    await manager.addForward('conn-2', conn as never, 3001, 'localhost', 8081)
    await manager.addForward('conn-1', conn as never, 3002, 'localhost', 8082)

    expect(manager.listForwards('conn-1')).toHaveLength(2)
    expect(manager.listForwards('conn-2')).toHaveLength(1)
    expect(manager.listForwards()).toHaveLength(3)
  })

  it('removes a forward by id', async () => {
    const conn = createMockConn()
    const entry = await manager.addForward('conn-1', conn as never, 3000, 'localhost', 8080)

    const removed = manager.removeForward(entry.id)
    expect(removed).toMatchObject({ id: entry.id, localPort: 3000 })
    expect(manager.listForwards()).toHaveLength(0)
  })

  it('returns null when removing nonexistent forward', () => {
    expect(manager.removeForward('nonexistent')).toBeNull()
  })

  it('removes all forwards for a connection', async () => {
    const conn = createMockConn()
    await manager.addForward('conn-1', conn as never, 3000, 'localhost', 8080)
    await manager.addForward('conn-1', conn as never, 3001, 'localhost', 8081)
    await manager.addForward('conn-2', conn as never, 3002, 'localhost', 8082)

    manager.removeAllForwards('conn-1')
    expect(manager.listForwards()).toHaveLength(1)
    expect(manager.listForwards('conn-2')).toHaveLength(1)
  })

  it('dispose removes all forwards', async () => {
    const conn = createMockConn()
    await manager.addForward('conn-1', conn as never, 3000, 'localhost', 8080)
    await manager.addForward('conn-2', conn as never, 3001, 'localhost', 8081)

    manager.dispose()
    expect(manager.listForwards()).toHaveLength(0)
  })

  it('stores label in the entry', async () => {
    const conn = createMockConn()
    const entry = await manager.addForward(
      'conn-1',
      conn as never,
      3000,
      'localhost',
      8080,
      'Web Server'
    )

    expect(entry.label).toBe('Web Server')
  })
})
