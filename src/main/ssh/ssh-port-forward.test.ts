import { describe, expect, it, vi, beforeEach } from 'vitest'
import { SshPortForwardManager } from './ssh-port-forward'

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
    mockClient,
    mockChannel
  }
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
    const conn = { getClient: vi.fn().mockReturnValue(null) }
    await expect(
      manager.addForward('conn-1', conn as never, 3000, 'localhost', 8080)
    ).rejects.toThrow('SSH connection is not established')
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
