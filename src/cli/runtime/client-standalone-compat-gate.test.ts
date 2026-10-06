import { randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { RuntimeClient } from './client'
import { RUNTIME_PROTOCOL_VERSION } from '../../shared/protocol-version'

const servers = new Set<Server>()
const sockets = new Set<Socket>()

afterEach(async () => {
  delete process.env.ORCA_CLI_STANDALONE
  for (const socket of sockets) {
    socket.destroy()
  }
  sockets.clear()
  await Promise.all(
    [...servers].map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  )
  servers.clear()
})

async function startLocalRuntime(status: Record<string, unknown>): Promise<{
  userDataPath: string
  methods: string[]
}> {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-standalone-compat-'))
  // Windows runtimes listen on a named pipe, the transport the desktop app publishes there.
  const transport =
    process.platform === 'win32'
      ? { kind: 'named-pipe', endpoint: `\\\\.\\pipe\\orca-standalone-compat-${randomUUID()}` }
      : { kind: 'unix', endpoint: join(userDataPath, 'runtime.sock') }
  const { endpoint } = transport
  const methods: string[] = []
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    socket.once('data', (data) => {
      const request: unknown = JSON.parse(String(data).trim())
      if (typeof request !== 'object' || request === null) {
        return
      }
      const id = 'id' in request ? request.id : null
      const method = 'method' in request && typeof request.method === 'string' ? request.method : ''
      methods.push(method)
      socket.write(
        `${JSON.stringify({
          id,
          ok: true,
          result: method === 'status.get' ? status : { listed: true },
          _meta: { runtimeId: 'runtime-1' }
        })}\n`
      )
    })
  })
  servers.add(server)
  await new Promise<void>((resolve) => server.listen(endpoint, resolve))
  writeFileSync(
    join(userDataPath, 'orca-runtime.json'),
    JSON.stringify({
      runtimeId: 'runtime-1',
      pid: process.pid,
      transports: [transport],
      authToken: 'token',
      startedAt: Date.now()
    }),
    'utf8'
  )
  return { userDataPath, methods }
}

describe('RuntimeClient local compat gate', () => {
  it('keeps the desktop CLI on a single local request', async () => {
    const { userDataPath, methods } = await startLocalRuntime({})
    const client = new RuntimeClient(userDataPath, 1_000, null, null)

    await client.call('repo.list')

    expect(methods).toEqual(['repo.list'])
  })

  it('checks the protocol window once before the first standalone request', async () => {
    process.env.ORCA_CLI_STANDALONE = '1'
    const { userDataPath, methods } = await startLocalRuntime({
      runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
      minCompatibleRuntimeClientVersion: 2
    })
    const client = new RuntimeClient(userDataPath, 1_000, null, null)

    await client.call('repo.list')
    await client.call('repo.list')

    expect(methods).toEqual(['status.get', 'repo.list', 'repo.list'])
  })

  it('refuses a local runtime that requires a newer client without sending the request', async () => {
    process.env.ORCA_CLI_STANDALONE = '1'
    const { userDataPath, methods } = await startLocalRuntime({
      runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION + 1,
      minCompatibleRuntimeClientVersion: RUNTIME_PROTOCOL_VERSION + 1
    })
    const client = new RuntimeClient(userDataPath, 1_000, null, null)

    await expect(client.call('repo.list')).rejects.toMatchObject({ code: 'incompatible_runtime' })
    expect(methods).toEqual(['status.get'])
  })

  it('reports both protocol windows from a compatible local runtime', async () => {
    process.env.ORCA_CLI_STANDALONE = '1'
    const { userDataPath } = await startLocalRuntime({
      runtimeId: 'runtime-1',
      graphStatus: 'ready',
      runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
      minCompatibleRuntimeClientVersion: 2
    })

    const status = await new RuntimeClient(userDataPath, 1_000, null, null).getCliStatus()

    expect(status.result.runtime).toMatchObject({
      reachable: true,
      runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
      minCompatibleRuntimeClientVersion: 2
    })
  })

  it('refuses local status from a runtime that requires a newer standalone CLI', async () => {
    process.env.ORCA_CLI_STANDALONE = '1'
    const { userDataPath } = await startLocalRuntime({
      runtimeId: 'runtime-1',
      graphStatus: 'ready',
      runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION + 1,
      minCompatibleRuntimeClientVersion: RUNTIME_PROTOCOL_VERSION + 1
    })

    const status = new RuntimeClient(userDataPath, 1_000, null, null).getCliStatus()

    await expect(status).rejects.toMatchObject({
      code: 'incompatible_runtime',
      message: expect.stringContaining('Update the standalone Orca CLI')
    })
  })

  it('keeps desktop local status diagnostic for the same runtime', async () => {
    const { userDataPath } = await startLocalRuntime({
      runtimeId: 'runtime-1',
      graphStatus: 'ready',
      runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION + 1,
      minCompatibleRuntimeClientVersion: RUNTIME_PROTOCOL_VERSION + 1
    })

    const status = await new RuntimeClient(userDataPath, 1_000, null, null).getCliStatus()

    expect(status.result.runtime.reachable).toBe(true)
  })
})
