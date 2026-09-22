import { createConnection, createServer, type Server } from 'node:net'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  isWindowsRuntimePipeBrokerEnabled,
  readWindowsRuntimePipeBrokerSandboxAccount,
  resolveWindowsRuntimePipeBrokerPath,
  WindowsRuntimePipeBrokerTransport
} from './windows-runtime-pipe-broker-transport'

const executablePath = 'native/windows-runtime-pipe-broker/.build/orca-pipe-broker.exe'
const authorizedSandboxAccount = `${process.env.COMPUTERNAME}\\${process.env.USERNAME}`
const transports: WindowsRuntimePipeBrokerTransport[] = []
const servers: Server[] = []

describe('WindowsRuntimePipeBrokerTransport package boundary', () => {
  it('keeps a packaged missing broker inside resources instead of falling back to a checkout', () => {
    const resources = mkdtempSync(join(tmpdir(), 'orca-no-packaged-broker-'))
    expect(resolveWindowsRuntimePipeBrokerPath(resources)).toBe(
      join(resources, 'bin', 'orca-pipe-broker.exe')
    )
  })

  it('reports an explicit error when the feature is enabled without a broker binary', async () => {
    const resources = mkdtempSync(join(tmpdir(), 'orca-no-packaged-broker-'))
    const executablePath = resolveWindowsRuntimePipeBrokerPath(resources)
    const transport = new WindowsRuntimePipeBrokerTransport({
      serverPid: process.pid,
      runtimeId: 'missing-broker',
      authorizedSandboxAccount: 'WORKSTATION\\CodexSandboxOffline',
      executablePath
    })
    await expect(transport.start()).rejects.toThrow(
      `Windows runtime pipe broker is missing: ${executablePath}`
    )
  })
})

afterEach(async () => {
  await Promise.all(transports.splice(0).map(async (transport) => transport.stop().catch(() => {})))
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
        })
    )
  )
})

describe.skipIf(process.platform !== 'win32')('WindowsRuntimePipeBrokerTransport', () => {
  it('stays disabled unless the experimental flag is exactly one', () => {
    expect(isWindowsRuntimePipeBrokerEnabled({})).toBe(false)
    expect(
      isWindowsRuntimePipeBrokerEnabled({ ORCA_EXPERIMENTAL_WINDOWS_PIPE_BROKER: 'true' })
    ).toBe(false)
    expect(isWindowsRuntimePipeBrokerEnabled({ ORCA_EXPERIMENTAL_WINDOWS_PIPE_BROKER: '1' })).toBe(
      true
    )
  })

  it('requires an explicit server-side sandbox account when enabled', () => {
    expect(() => readWindowsRuntimePipeBrokerSandboxAccount({})).toThrow(
      /must name one explicit local sandbox user/
    )
    expect(
      readWindowsRuntimePipeBrokerSandboxAccount({
        ORCA_EXPERIMENTAL_WINDOWS_PIPE_BROKER_SANDBOX_ACCOUNT: 'WORKSTATION\\CodexSandboxOffline'
      })
    ).toBe('WORKSTATION\\CodexSandboxOffline')
  })

  it('preserves RPC authentication and rejects an invalid credential', async () => {
    const response = await runRpcCase('invalid-capability')
    expect(response).toEqual({
      id: 'request-1',
      ok: false,
      error: { code: 'unauthorized', message: 'Invalid auth token' }
    })
  })

  it('forwards an authenticated RPC response through the exact private instance', async () => {
    const response = await runRpcCase('valid-capability')
    expect(response).toEqual({ id: 'request-1', ok: true, result: { pong: true } })
  })

  it('fails readiness when the configured private runtime identity is invalid', async () => {
    const transport = new WindowsRuntimePipeBrokerTransport({
      serverPid: process.pid + 1,
      runtimeId: 'wrong-runtime',
      authorizedSandboxAccount,
      executablePath,
      instanceId: 'wrong-parent',
      sessionDeadlineMs: 250
    })
    transports.push(transport)
    await expect(transport.start()).rejects.toThrow(/exited before ready/)
  })
})

async function runRpcCase(authToken: string): Promise<unknown> {
  const runtimeId = `test${Date.now().toString(36)}`
  const suffix = runtimeId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 4) || 'rt'
  const privateEndpoint = `\\\\.\\pipe\\orca-${process.pid}-${suffix}`
  const server = createServer((socket) => {
    socket.setEncoding('utf8')
    socket.once('data', (data: string) => {
      const request = JSON.parse(data.trim()) as { id: string; authToken: string }
      const response =
        request.authToken === 'valid-capability'
          ? { id: request.id, ok: true, result: { pong: true } }
          : {
              id: request.id,
              ok: false,
              error: { code: 'unauthorized', message: 'Invalid auth token' }
            }
      socket.end(`${JSON.stringify(response)}\n`)
    })
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(privateEndpoint, resolve)
  })

  const transport = new WindowsRuntimePipeBrokerTransport({
    serverPid: process.pid,
    runtimeId,
    authorizedSandboxAccount,
    executablePath,
    sessionDeadlineMs: 2_000
  })
  transports.push(transport)
  await transport.start()

  return await new Promise((resolve, reject) => {
    const client = createConnection(transport.endpoint)
    let reply = ''
    client.setEncoding('utf8')
    client.once('error', reject)
    client.on('data', (chunk: string) => {
      reply += chunk
    })
    client.once('end', () => resolve(JSON.parse(reply.trim())))
    client.once('connect', () => {
      client.write(
        `${JSON.stringify({ id: 'request-1', authToken, method: 'diagnostics.ping' })}\n`
      )
    })
  })
}
