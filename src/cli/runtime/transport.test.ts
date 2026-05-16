import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createServer, type Socket } from 'net'
import { afterEach, describe, expect, it } from 'vitest'
import type { RuntimeMetadata } from '../../shared/runtime-bootstrap'
import { sendRequest } from './transport'

const servers = new Set<ReturnType<typeof createServer>>()
const sockets = new Set<Socket>()

afterEach(async () => {
  for (const socket of sockets) {
    socket.destroy()
  }
  sockets.clear()
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
        })
    )
  )
  servers.clear()
})

// Why: these tests create Unix domain socket servers in temp directories.
// Windows does not support Unix domain sockets in the same way.
describe.skipIf(process.platform === 'win32')('runtime transport', () => {
  it('refreshes the per-call timeout when the runtime sends keepalive frames', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-transport-'))
    const endpoint = join(userDataPath, 'runtime.sock')
    const server = createServer((socket) => {
      sockets.add(socket)
      let keepalive: ReturnType<typeof setInterval> | null = null
      socket.once('close', () => {
        sockets.delete(socket)
        if (keepalive) {
          clearInterval(keepalive)
        }
      })
      socket.once('data', (data) => {
        const request = JSON.parse(String(data).trim()) as { id: string }
        keepalive = setInterval(() => {
          socket.write('{"_keepalive":true}\n')
        }, 15)
        setTimeout(() => {
          if (keepalive) {
            clearInterval(keepalive)
            keepalive = null
          }
          socket.write(
            `${JSON.stringify({
              id: request.id,
              ok: true,
              result: { satisfied: true },
              _meta: { runtimeId: 'runtime-1' }
            })}\n`
          )
        }, 90)
      })
    })
    servers.add(server)
    await new Promise<void>((resolve) => server.listen(endpoint, resolve))

    const metadata: RuntimeMetadata = {
      runtimeId: 'runtime-1',
      pid: 123,
      transports: [{ kind: 'unix', endpoint }],
      authToken: 'token',
      startedAt: 1
    }
    const response = await sendRequest<{ satisfied: boolean }>(
      metadata,
      'terminal.wait',
      undefined,
      40
    )

    expect(response).toMatchObject({
      ok: true,
      result: { satisfied: true }
    })
  })
})
