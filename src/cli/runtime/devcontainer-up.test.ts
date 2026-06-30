import { EventEmitter } from 'events'
import { createServer } from 'net'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnMock, upsertEnvironmentFromPairingCodeMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  upsertEnvironmentFromPairingCodeMock: vi.fn()
}))

vi.mock('child_process', () => ({
  spawn: spawnMock
}))

vi.mock('./environments', () => ({
  upsertEnvironmentFromPairingCode: upsertEnvironmentFromPairingCodeMock
}))

import { startDevcontainerUp } from './devcontainer-up'

function createChild(): EventEmitter & {
  stdout: EventEmitter
  stderr: EventEmitter
  kill: ReturnType<typeof vi.fn>
  unref: ReturnType<typeof vi.fn>
  exitCode: number | null
  signalCode: NodeJS.Signals | null
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    kill: ReturnType<typeof vi.fn>
    unref: ReturnType<typeof vi.fn>
    exitCode: number | null
    signalCode: NodeJS.Signals | null
  }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = vi.fn()
  child.unref = vi.fn()
  child.exitCode = null
  child.signalCode = null
  return child
}

function emitExit(
  child: EventEmitter & { exitCode: number | null; signalCode: NodeJS.Signals | null },
  code: number | null,
  signal: NodeJS.Signals | null
): void {
  child.exitCode = code
  child.signalCode = signal
  child.emit('exit', code, signal)
}

async function listenOnLoopbackPort(): Promise<{ close: () => Promise<void>; port: number }> {
  const server = createServer()
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (address == null || typeof address === 'string') {
    throw new Error('Expected an IPv4 address info')
  }
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error)
            return
          }
          resolve()
        })
      })
  }
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('startDevcontainerUp', () => {
  beforeEach(() => {
    spawnMock.mockReset()
    upsertEnvironmentFromPairingCodeMock.mockReset()
  })

  it('spawns the Docker bridge, waits for readiness, and upserts the saved environment', async () => {
    const inspectChild = createChild()
    const bridgeChild = createChild()
    const serveChild = createChild()
    const listener = await listenOnLoopbackPort()
    const savedEnvironment = {
      id: 'env-1',
      name: 'lac-devcontainer',
      createdAt: 100,
      updatedAt: 200,
      lastUsedAt: null,
      runtimeId: 'runtime-123',
      endpoints: [
        {
          id: 'ws-env-1',
          kind: 'websocket',
          label: 'WebSocket',
          endpoint: 'orca://pair?code=ready',
          deviceToken: 'token',
          publicKeyB64: 'pk'
        }
      ],
      preferredEndpointId: 'ws-env-1'
    }

    spawnMock
      .mockReturnValueOnce(inspectChild)
      .mockReturnValueOnce(bridgeChild)
      .mockReturnValueOnce(serveChild)
    upsertEnvironmentFromPairingCodeMock.mockReturnValue(savedEnvironment)

    const session = startDevcontainerUp({
      userDataPath: '/tmp/orca-user-data',
      name: 'lac-devcontainer',
      container: 'lac-devcontainer',
      hostPort: listener.port,
      containerPort: 6_768,
      orcaBin: 'orca',
      bridgeName: 'orca-devcontainer-lac'
    })

    inspectChild.stdout.emit('data', 'dev-net\t172.18.0.22\n')
    inspectChild.emit('exit', 0, null)
    await flush()

    expect(spawnMock).toHaveBeenCalledTimes(3)
    expect(spawnMock.mock.calls[1]).toEqual([
      'docker',
      [
        'run',
        '--rm',
        '--name',
        'orca-devcontainer-lac',
        '--network',
        'dev-net',
        '-p',
        `127.0.0.1:${listener.port}:${listener.port}`,
        'alpine',
        'sh',
        '-lc',
        `apk add --no-cache socat >/dev/null 2>&1 && exec socat -d -d TCP-LISTEN:${listener.port},fork,reuseaddr TCP:172.18.0.22:6768`
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    ])
    expect(spawnMock.mock.calls[2]).toEqual([
      'docker',
      [
        'exec',
        'lac-devcontainer',
        'sh',
        '-lc',
        `orca serve --json --port 6768 --pairing-address 127.0.0.1:${listener.port}`
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    ])

    serveChild.stdout.emit(
      'data',
      '{"type":"orca_server_ready","runtimeId":"runtime-123","endpoint":"ws://127.0.0.1:6768","pairing":{"url":"orca://pair?code=ready"}}\n'
    )

    await expect(session.ready).resolves.toEqual(savedEnvironment)
    expect(upsertEnvironmentFromPairingCodeMock).toHaveBeenCalledWith('/tmp/orca-user-data', {
      name: 'lac-devcontainer',
      pairingCode: 'orca://pair?code=ready',
      runtimeId: 'runtime-123',
      now: undefined
    })

    emitExit(serveChild, 0, null)
    await expect(session.done).resolves.toBeUndefined()
    expect(bridgeChild.kill).toHaveBeenCalledWith('SIGTERM')
    await listener.close()
  })

  it('rejects when the bridge fails or collides before saving the environment', async () => {
    const inspectChild = createChild()
    const bridgeChild = createChild()
    const serveChild = createChild()
    const listener = await listenOnLoopbackPort()

    spawnMock
      .mockReturnValueOnce(inspectChild)
      .mockReturnValueOnce(bridgeChild)
      .mockReturnValueOnce(serveChild)

    const session = startDevcontainerUp({
      userDataPath: '/tmp/orca-user-data',
      name: 'lac-devcontainer',
      container: 'lac-devcontainer',
      hostPort: listener.port,
      containerPort: 6_768,
      orcaBin: 'orca',
      bridgeName: 'orca-devcontainer-lac'
    })

    inspectChild.stdout.emit('data', 'dev-net\t172.18.0.22\n')
    emitExit(inspectChild, 0, null)
    await flush()
    bridgeChild.stderr.emit(
      'data',
      'docker: Error response from daemon: driver failed programming external connectivity on endpoint bridge (port is already allocated)\n'
    )
    emitExit(bridgeChild, 1, null)

    await expect(session.ready).rejects.toThrow('port is already allocated')
    await expect(session.done).rejects.toThrow('port is already allocated')
    expect(upsertEnvironmentFromPairingCodeMock).not.toHaveBeenCalled()
    expect(serveChild.kill).toHaveBeenCalledWith('SIGTERM')
    await listener.close()
  })

  it('resolves done when serve exits immediately after readiness', async () => {
    const inspectChild = createChild()
    const bridgeChild = createChild()
    const serveChild = createChild()
    const listener = await listenOnLoopbackPort()

    spawnMock
      .mockReturnValueOnce(inspectChild)
      .mockReturnValueOnce(bridgeChild)
      .mockReturnValueOnce(serveChild)
    upsertEnvironmentFromPairingCodeMock.mockReturnValue({
      id: 'env-1',
      name: 'lac-devcontainer',
      createdAt: 100,
      updatedAt: 200,
      lastUsedAt: null,
      runtimeId: 'runtime-123',
      endpoints: [],
      preferredEndpointId: null
    })

    const session = startDevcontainerUp({
      userDataPath: '/tmp/orca-user-data',
      name: 'lac-devcontainer',
      container: 'lac-devcontainer',
      hostPort: listener.port,
      containerPort: 6_768,
      orcaBin: 'orca',
      bridgeName: 'orca-devcontainer-lac'
    })

    inspectChild.stdout.emit('data', 'dev-net\t172.18.0.22\n')
    emitExit(inspectChild, 0, null)
    await flush()

    serveChild.stdout.emit(
      'data',
      '{"type":"orca_server_ready","runtimeId":"runtime-123","pairing":{"url":"orca://pair?code=ready"}}\n'
    )
    emitExit(serveChild, 0, null)

    await expect(session.ready).resolves.toMatchObject({ runtimeId: 'runtime-123' })
    await expect(session.done).resolves.toBeUndefined()
    await listener.close()
  })

  it('kills the serve child when upserting the environment fails', async () => {
    const inspectChild = createChild()
    const bridgeChild = createChild()
    const serveChild = createChild()
    const listener = await listenOnLoopbackPort()

    spawnMock
      .mockReturnValueOnce(inspectChild)
      .mockReturnValueOnce(bridgeChild)
      .mockReturnValueOnce(serveChild)
    upsertEnvironmentFromPairingCodeMock.mockImplementation(() => {
      throw new Error('write failed')
    })

    const session = startDevcontainerUp({
      userDataPath: '/tmp/orca-user-data',
      name: 'lac-devcontainer',
      container: 'lac-devcontainer',
      hostPort: listener.port,
      containerPort: 6_768,
      orcaBin: 'orca',
      bridgeName: 'orca-devcontainer-lac'
    })

    inspectChild.stdout.emit('data', 'dev-net\t172.18.0.22\n')
    emitExit(inspectChild, 0, null)
    await flush()

    serveChild.stdout.emit(
      'data',
      '{"type":"orca_server_ready","runtimeId":"runtime-123","pairing":{"url":"orca://pair?code=ready"}}\n'
    )

    await expect(session.ready).rejects.toThrow('write failed')
    await expect(session.done).rejects.toThrow('write failed')
    expect(serveChild.kill).toHaveBeenCalledWith('SIGTERM')
    expect(bridgeChild.kill).toHaveBeenCalledWith('SIGTERM')
    await listener.close()
  })
})
