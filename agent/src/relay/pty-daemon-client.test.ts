import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as net from 'node:net'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import type { AgentLogger } from './agent-logger'
import {
  DaemonMessageDecoder,
  encodeDaemonMessage,
  isDaemonRequest,
  type DaemonMessage
} from './pty-daemon-protocol'

const spawnChildMock = vi.fn()
vi.mock('node:child_process', () => ({ spawn: spawnChildMock }))

const log: AgentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
} as unknown as AgentLogger

let scratchHome: string
let originalHome: string | undefined
let servers: net.Server[] = []
let acceptedSockets: net.Socket[] = []
let testCounter = 0

function socketPathUnderHome(): string {
  return path.join(scratchHome, 'orca-agent', 'pty-daemon.sock')
}

/** A minimal fake daemon: replies to `method` with `result`, and can push notifications. */
function startFakeDaemon(
  socketPath: string,
  handler: (method: string, params: Record<string, unknown> | undefined) => unknown
): {
  server: net.Server
  pushNotification: (method: string, params: Record<string, unknown>) => void
} {
  fs.mkdirSync(path.dirname(socketPath), { recursive: true })
  const sockets = new Set<net.Socket>()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    acceptedSockets.push(socket)
    const decoder = new DaemonMessageDecoder((msg: DaemonMessage) => {
      if (!isDaemonRequest(msg)) {
        return
      }
      const result = handler(msg.method, msg.params)
      socket.write(encodeDaemonMessage({ id: msg.id, result }))
    })
    socket.on('data', (chunk) => decoder.feed(chunk.toString('utf8')))
    socket.on('close', () => sockets.delete(socket))
  })
  server.listen(socketPath)
  servers.push(server)
  return {
    server,
    pushNotification: (method, params) => {
      const line = encodeDaemonMessage({ method, params })
      for (const s of sockets) {
        s.write(line)
      }
    }
  }
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  originalHome = process.env['HOME']
  scratchHome = path.join(os.tmpdir(), `orca-pty-client-test-${process.pid}-${testCounter++}`)
  fs.mkdirSync(scratchHome, { recursive: true })
  process.env['HOME'] = scratchHome
  spawnChildMock.mockReturnValue({ unref: vi.fn() })
})

afterEach(async () => {
  process.env['HOME'] = originalHome
  for (const socket of acceptedSockets) {
    socket.destroy()
  }
  acceptedSockets = []
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))))
  servers = []
})

describe('pty-daemon-client', () => {
  it('connects directly and forwards a request when a daemon is already listening', async () => {
    const socketPath = socketPathUnderHome()
    startFakeDaemon(socketPath, (method) => {
      expect(method).toBe('pty.create')
      return { id: 'agent-pty-123' }
    })

    const { handlePtyCreate } = await import('./pty-daemon-client')
    const notify = vi.fn()
    const response = await handlePtyCreate(1, { cols: 80, rows: 24 }, log, notify)
    expect(response).toMatchObject({ jsonrpc: '2.0', id: 1, result: { id: 'agent-pty-123' } })
    expect(spawnChildMock).not.toHaveBeenCalled()
  })

  it('spawns the daemon when nothing is listening yet, then connects once it comes up', async () => {
    const socketPath = socketPathUnderHome()

    // Simulate the spawned daemon process becoming ready shortly after spawn() is called.
    spawnChildMock.mockImplementation(() => {
      setTimeout(() => {
        startFakeDaemon(socketPath, () => ({ ok: true, ptys: 0 }))
      }, 150)
      return { unref: vi.fn() }
    })

    const { handlePtyCreate } = await import('./pty-daemon-client')
    const response = await handlePtyCreate(1, {}, log, vi.fn())

    expect(spawnChildMock).toHaveBeenCalledTimes(1)
    const [command, args, opts] = spawnChildMock.mock.calls[0] as [
      string,
      string[],
      { env: Record<string, string>; detached: boolean }
    ]
    expect(command).toBe(process.execPath)
    expect(args).toEqual([process.argv[1]])
    expect(opts.detached).toBe(true)
    expect(opts.env['ORCA_PTY_DAEMON_SOCKET']).toBe(socketPath)
    expect(response).toMatchObject({ jsonrpc: '2.0', id: 1, result: { ok: true, ptys: 0 } })
  }, 8000)

  it('dedupes concurrent connection attempts into a single spawn', async () => {
    const socketPath = socketPathUnderHome()
    spawnChildMock.mockImplementation(() => {
      setTimeout(() => {
        startFakeDaemon(socketPath, () => ({ ok: true }))
      }, 150)
      return { unref: vi.fn() }
    })

    const { handlePtyCreate, handlePtyWrite } = await import('./pty-daemon-client')
    const [a, b] = await Promise.all([
      handlePtyCreate(1, {}, log, vi.fn()),
      handlePtyWrite(2, { id: 'x', data: 'y' }, log)
    ])
    expect(spawnChildMock).toHaveBeenCalledTimes(1)
    expect(a).toMatchObject({ id: 1, result: { ok: true } })
    expect(b).toMatchObject({ id: 2, result: { ok: true } })
  }, 8000)

  it('routes a daemon-pushed notification to whichever notify callback is currently bound', async () => {
    const socketPath = socketPathUnderHome()
    const { pushNotification } = startFakeDaemon(socketPath, () => ({ id: 'agent-pty-1' }))

    const { handlePtyCreate, handlePtyAttach } = await import('./pty-daemon-client')
    const firstNotify = vi.fn()
    await handlePtyCreate(1, {}, log, firstNotify)

    const secondNotify = vi.fn()
    await handlePtyAttach(2, { id: 'agent-pty-1' }, log, secondNotify)

    pushNotification('pty.data', { id: 'agent-pty-1', data: 'hello' })
    await vi.waitFor(() => {
      if (secondNotify.mock.calls.length === 0) {
        throw new Error('not yet notified')
      }
    })
    expect(secondNotify).toHaveBeenCalledWith('pty.data', { id: 'agent-pty-1', data: 'hello' })
    expect(firstNotify).not.toHaveBeenCalled()
  })

  it('notifyDaemonSessionClosed swallows a failure to reach the daemon', async () => {
    // Force a synchronous spawn failure so ensureConnection rejects fast instead of
    // waiting out the full spawn-wait timeout.
    spawnChildMock.mockImplementation(() => {
      throw new Error('spawn EPERM (simulated)')
    })

    const { notifyDaemonSessionClosed } = await import('./pty-daemon-client')
    await expect(notifyDaemonSessionClosed(log)).resolves.toBeUndefined()
  })

  // CR-STORAGE-008(a)/TASK-AG-STORAGE-007
  it('notifyDaemonSessionTeardown swallows a failure to reach the daemon', async () => {
    spawnChildMock.mockImplementation(() => {
      throw new Error('spawn EPERM (simulated)')
    })

    const { notifyDaemonSessionTeardown } = await import('./pty-daemon-client')
    await expect(notifyDaemonSessionTeardown(log)).resolves.toBeUndefined()
  })

  it('notifyDaemonSessionTeardown sends daemon.sessionTeardown to a live daemon', async () => {
    const socketPath = socketPathUnderHome()
    let seenMethod: string | undefined
    startFakeDaemon(socketPath, (method) => {
      seenMethod = method
      return { ok: true }
    })

    const { notifyDaemonSessionTeardown } = await import('./pty-daemon-client')
    await notifyDaemonSessionTeardown(log)

    expect(seenMethod).toBe('daemon.sessionTeardown')
  })
})
