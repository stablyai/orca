import { EventEmitter } from 'node:events'
import { createServer } from 'node:net'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { SshPortForwardManager } from './ssh-port-forward'

const { startSystemSshPortForwardProcessMock } = vi.hoisted(() => ({
  startSystemSshPortForwardProcessMock: vi.fn()
}))

vi.mock('./system-ssh-forward-process', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    startSystemSshPortForwardProcess: startSystemSshPortForwardProcessMock
  }
})

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

function createFakeSystemSshForward() {
  const process = Object.assign(new EventEmitter(), { stderr: new EventEmitter() })
  return {
    process,
    waitForStartup: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn()
  }
}

function createFakeSocket() {
  const socket = new EventEmitter() as EventEmitter & {
    destroyed: boolean
    destroy: ReturnType<typeof vi.fn>
    pipe: ReturnType<typeof vi.fn>
  }
  socket.destroyed = false
  socket.destroy = vi.fn().mockImplementation(() => {
    socket.destroyed = true
    socket.emit('close')
  })
  socket.pipe = vi.fn().mockReturnValue(socket)
  return socket
}

function getLastMockServer() {
  const createServerMock = vi.mocked(createServer)
  return createServerMock.mock.results.at(-1)?.value as
    | {
        _connectionHandler: (socket: ReturnType<typeof createFakeSocket>) => void
      }
    | undefined
}

vi.mock('net', () => {
  return {
    createServer: vi.fn().mockImplementation((connectionHandler) => {
      const listeners = new Map<string, (...args: unknown[]) => void>()
      const server = {
        listen: vi.fn().mockImplementation(() => {
          listeners.get('listening')?.()
        }),
        close: vi.fn().mockImplementation((cb?: () => void) => cb?.()),
        once: vi.fn().mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
          listeners.set(event, handler)
        }),
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
    startSystemSshPortForwardProcessMock.mockReset()
  })

  it('adds an ssh2 port forward and returns entry', async () => {
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

  it('throws when no port forward provider can handle the connection', async () => {
    const conn = {
      getClient: vi.fn().mockReturnValue(null),
      usesSystemSshTransport: vi.fn().mockReturnValue(false)
    }
    await expect(
      manager.addForward('conn-1', conn as never, 3000, 'localhost', 8080)
    ).rejects.toThrow('SSH connection is not established')
  })

  it('adds a system SSH port forward when no ssh2 client is available', async () => {
    const forward = createFakeSystemSshForward()
    startSystemSshPortForwardProcessMock.mockReturnValue(forward)
    const conn = createSystemSshConn()

    const entry = await manager.addForward('conn-1', conn as never, 3000, '127.0.0.1', 8080)

    expect(startSystemSshPortForwardProcessMock).toHaveBeenCalledWith(
      conn.getTarget(),
      3000,
      '127.0.0.1',
      8080
    )
    expect(forward.waitForStartup).toHaveBeenCalled()
    expect(entry).toMatchObject({
      connectionId: 'conn-1',
      localPort: 3000,
      remoteHost: '127.0.0.1',
      remotePort: 8080
    })
    expect(manager.listForwards('conn-1')).toHaveLength(1)
  })

  it('does not register a system SSH forward when startup fails', async () => {
    const forward = createFakeSystemSshForward()
    forward.waitForStartup.mockRejectedValue(new Error('bind: Address already in use'))
    startSystemSshPortForwardProcessMock.mockReturnValue(forward)
    const conn = createSystemSshConn()

    await expect(
      manager.addForward('conn-1', conn as never, 3000, '127.0.0.1', 8080)
    ).rejects.toThrow('bind: Address already in use')
    expect(manager.listForwards('conn-1')).toHaveLength(0)
  })

  it('disposes a system SSH tunnel when removing the forward', async () => {
    const forward = createFakeSystemSshForward()
    startSystemSshPortForwardProcessMock.mockReturnValue(forward)
    const conn = createSystemSshConn()

    const entry = await manager.addForward('conn-1', conn as never, 3000, '127.0.0.1', 8080)

    expect(manager.removeForward(entry.id)).toMatchObject({ id: entry.id })
    expect(forward.dispose).toHaveBeenCalled()
    expect(manager.listForwards('conn-1')).toHaveLength(0)
  })

  it('awaits system SSH tunnel close before async removal resolves', async () => {
    let resolveClose!: () => void
    const forward = createFakeSystemSshForward()
    forward.close.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveClose = resolve
      })
    )
    startSystemSshPortForwardProcessMock.mockReturnValue(forward)
    const conn = createSystemSshConn()

    await manager.addForward('conn-1', conn as never, 3000, '127.0.0.1', 8080)

    let resolved = false
    const removal = manager.removeAllForwards('conn-1').then(() => {
      resolved = true
    })

    await Promise.resolve()
    expect(resolved).toBe(false)
    resolveClose()
    await removal
    expect(resolved).toBe(true)
  })

  it('removes an unexpectedly exited system SSH forward and calls the close callback', async () => {
    const onForwardClosed = vi.fn()
    manager.setCallbacks({ onForwardClosed })
    const forward = createFakeSystemSshForward()
    startSystemSshPortForwardProcessMock.mockReturnValue(forward)
    const conn = createSystemSshConn()

    const entry = await manager.addForward('conn-1', conn as never, 3000, '127.0.0.1', 8080)
    forward.process.stderr.emit('data', Buffer.from('channel open failed'))
    forward.process.emit('exit', 255)

    expect(manager.listForwards('conn-1')).toHaveLength(0)
    expect(onForwardClosed).toHaveBeenCalledWith(
      entry,
      expect.objectContaining({
        kind: 'unexpected-exit',
        detail: expect.stringContaining('channel open failed')
      })
    )
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

  it('awaits forward close when removing a forward for user actions', async () => {
    const conn = createMockConn()
    const entry = await manager.addForward('conn-1', conn as never, 3000, 'localhost', 8080)

    await expect(manager.removeForwardAndWait(entry.id)).resolves.toMatchObject({
      id: entry.id,
      localPort: 3000
    })
    expect(manager.listForwards()).toHaveLength(0)
  })

  it('destroys local sockets that emit errors', async () => {
    const conn = createMockConn()
    await manager.addForward('conn-1', conn as never, 3000, 'localhost', 8080)
    const server = getLastMockServer()
    const socket = createFakeSocket()

    server?._connectionHandler(socket)
    socket.emit('error', new Error('client reset'))

    expect(socket.destroy).toHaveBeenCalled()
  })

  it('closes late ssh2 channels after the forward was removed', async () => {
    const mockChannel = {
      pipe: vi.fn().mockReturnThis(),
      on: vi.fn(),
      close: vi.fn()
    }
    let callback!: (error: Error | undefined, channel: typeof mockChannel) => void
    const mockClient = {
      forwardOut: vi.fn().mockImplementation((_bindAddr, _bindPort, _destHost, _destPort, cb) => {
        callback = cb
      })
    }
    const conn = {
      getClient: vi.fn().mockReturnValue(mockClient),
      usesSystemSshTransport: vi.fn().mockReturnValue(false)
    }
    const entry = await manager.addForward('conn-1', conn as never, 3000, 'localhost', 8080)
    const server = getLastMockServer()
    const socket = createFakeSocket()

    server?._connectionHandler(socket)
    await manager.removeForwardAndWait(entry.id)
    callback(undefined, mockChannel)

    expect(mockChannel.close).toHaveBeenCalled()
    expect(socket.destroy).toHaveBeenCalled()
  })

  it('returns null when removing nonexistent forward', () => {
    expect(manager.removeForward('nonexistent')).toBeNull()
  })

  it('removes all forwards for a connection', async () => {
    const conn = createMockConn()
    await manager.addForward('conn-1', conn as never, 3000, 'localhost', 8080)
    await manager.addForward('conn-1', conn as never, 3001, 'localhost', 8081)
    await manager.addForward('conn-2', conn as never, 3002, 'localhost', 8082)

    await manager.removeAllForwards('conn-1')
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

  it('preserves the existing id when updating a forward succeeds', async () => {
    const conn = createMockConn()
    const entry = await manager.addForward('conn-1', conn as never, 3000, 'localhost', 8080)

    const updated = await manager.updateForward(entry.id, conn as never, 3001, 'localhost', 8081)

    expect(updated.id).toBe(entry.id)
    expect(updated.localPort).toBe(3001)
    expect(updated.remotePort).toBe(8081)
  })

  it('rolls back a failed system SSH update with the original id', async () => {
    const initialForward = createFakeSystemSshForward()
    const failedForward = createFakeSystemSshForward()
    const rollbackForward = createFakeSystemSshForward()
    failedForward.waitForStartup.mockRejectedValue(new Error('bind failed'))
    startSystemSshPortForwardProcessMock
      .mockReturnValueOnce(initialForward)
      .mockReturnValueOnce(failedForward)
      .mockReturnValueOnce(rollbackForward)
    const conn = createSystemSshConn()
    const entry = await manager.addForward('conn-1', conn as never, 3000, '127.0.0.1', 8080)

    await expect(
      manager.updateForward(entry.id, conn as never, 3001, '127.0.0.1', 8081)
    ).rejects.toThrow('bind failed')

    expect(initialForward.close).toHaveBeenCalled()
    expect(manager.listForwards('conn-1')).toEqual([
      expect.objectContaining({
        id: entry.id,
        localPort: 3000,
        remotePort: 8080
      })
    ])
  })
})
