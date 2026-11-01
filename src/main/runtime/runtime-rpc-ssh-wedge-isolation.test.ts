import './rpc/unused-default-rpc-methods.test-fixture'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnection, type Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { readRuntimeMetadata } from './runtime-metadata'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { STATUS_METHODS } from './rpc/methods/status'
import { SSH_METHODS } from './rpc/methods/ssh'
import { sendRequest } from './runtime-rpc-test-harness'

// Real socket probes must stay responsive while SSH is wedged on headless serve (#31179).
const { connectMock, removeMock } = vi.hoisted(() => {
  const never = (): Promise<never> => new Promise<never>(() => {})
  return { connectMock: vi.fn(never), removeMock: vi.fn(never) }
})

vi.mock('../ssh/targets/ssh-target-registry', () => ({
  connectRegisteredSshTarget: connectMock,
  getRegisteredSshState: () => ({
    targetId: 'ssh-1',
    status: 'reconnecting',
    error: null,
    reconnectAttempt: 6
  }),
  getRegisteredSshTargetMutations: () => ({ add: vi.fn(), update: vi.fn(), remove: removeMock }),
  getSshConnectionManager: () => null,
  listRegisteredSshTargets: () => [{ id: 'ssh-1', label: 'broker', host: 'h', port: 22 }],
  listRegisteredRemovedSshTargetLabels: () => ({}),
  SshTargetManagementUnservedError: class extends Error {}
}))

const servers: OrcaRuntimeRpcServer[] = []
const sockets: Socket[] = []
const userDataPaths: string[] = []

afterEach(async () => {
  vi.clearAllMocks()
  for (const socket of sockets.splice(0)) {
    socket.destroy()
  }
  await Promise.all(servers.splice(0).map((server) => server.stop()))
  for (const path of userDataPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

async function startServer(): Promise<{ endpoint: string; token: string }> {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-rpc-ssh-wedge-'))
  userDataPaths.push(userDataPath)
  const server = new OrcaRuntimeRpcServer({
    runtime: new OrcaRuntimeService(),
    userDataPath,
    methods: [...STATUS_METHODS, ...SSH_METHODS]
  })
  servers.push(server)
  await server.start()
  const metadata = readRuntimeMetadata(userDataPath)!
  return { endpoint: metadata.transports[0]!.endpoint, token: metadata.authToken ?? '' }
}

type RpcResponseFrame = Record<string, unknown> & { id: string }

/** Validates a server line at the socket boundary; frames without an id (keepalives) are skipped. */
function parseResponseFrame(line: string): RpcResponseFrame | null {
  const parsed: unknown = JSON.parse(line)
  if (typeof parsed !== 'object' || parsed === null || !('id' in parsed)) {
    return null
  }
  return { ...Object.fromEntries(Object.entries(parsed)), id: String(parsed.id) }
}

/** Writes every frame on one connection and collects responses by id. */
function openPipelinedSocket(endpoint: string): {
  write: (frame: Record<string, unknown>) => void
  next: (id: string) => Promise<RpcResponseFrame>
} {
  const socket = createConnection(endpoint)
  sockets.push(socket)
  const responses = new Map<string, RpcResponseFrame>()
  const waiters = new Map<string, (frame: RpcResponseFrame) => void>()
  let buffer = ''
  socket.setEncoding('utf8')
  // Wedged-socket reset should fail probe assertions, not crash the worker.
  socket.on('error', () => {})
  socket.on('data', (chunk: string) => {
    buffer += chunk
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const frame = parseResponseFrame(buffer.slice(0, newline))
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
      if (frame) {
        responses.set(frame.id, frame)
        waiters.get(frame.id)?.(frame)
      }
    }
  })
  return {
    write: (frame) => socket.write(`${JSON.stringify(frame)}\n`),
    next: (id) =>
      new Promise((resolve) => {
        const existing = responses.get(id)
        if (existing) {
          resolve(existing)
          return
        }
        waiters.set(id, resolve)
      })
  }
}

describe('runtime RPC with a wedged SSH layer (#31179)', () => {
  it('answers probes on fresh connections while SSH dispatches never settle', async () => {
    const { endpoint, token } = await startServer()
    // More wedged dispatches than the long-poll cap: short RPCs must not hold admission slots.
    for (let i = 0; i < 20; i += 1) {
      const wedged = openPipelinedSocket(endpoint)
      wedged.write({
        id: `wedged-${i}`,
        authToken: token,
        method: i % 2 === 0 ? 'ssh.connect' : 'ssh.removeTarget',
        params: { targetId: 'ssh-1' }
      })
    }
    await vi.waitFor(() =>
      expect(connectMock.mock.calls.length + removeMock.mock.calls.length).toBe(20)
    )

    await expect(
      sendRequest(endpoint, { id: 'list', authToken: token, method: 'ssh.listTargets' })
    ).resolves.toMatchObject({ ok: true, result: { targets: [{ id: 'ssh-1' }] } })
    await expect(
      sendRequest(endpoint, {
        id: 'state',
        authToken: token,
        method: 'ssh.getState',
        params: { targetId: 'ssh-1' }
      })
    ).resolves.toMatchObject({ ok: true, result: { state: { status: 'reconnecting' } } })
    await expect(
      sendRequest(endpoint, { id: 'status', authToken: token, method: 'status.get' })
    ).resolves.toMatchObject({ ok: true })
  })

  it('answers a probe pipelined behind a wedged dispatch on the same connection', async () => {
    const { endpoint, token } = await startServer()
    const session = openPipelinedSocket(endpoint)
    session.write({
      id: 'wedged',
      authToken: token,
      method: 'ssh.connect',
      params: { targetId: 'ssh-1' }
    })
    session.write({ id: 'list', authToken: token, method: 'ssh.listTargets' })

    await expect(session.next('list')).resolves.toMatchObject({ ok: true })
  })
})
