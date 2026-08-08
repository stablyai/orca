import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeMetadata } from '../../shared/runtime-bootstrap'
import { findTransport } from '../../shared/runtime-bootstrap'
import { readRuntimeMetadata } from './runtime-metadata'
import { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import type { RpcDispatcher } from './rpc/dispatcher'

type RpcServerInternals = {
  dispatcher: RpcDispatcher
}

describe('local terminal streaming RPC', () => {
  it('requires an explicit stream request and keeps one-shot rejection unchanged', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-local-terminal-stream-'))
    const runtime = new OrcaRuntimeService()
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath,
      enableWebSocket: false
    })
    const dispatcher = (server as unknown as RpcServerInternals).dispatcher
    const dispatchStreaming = vi
      .spyOn(dispatcher, 'dispatchStreaming')
      .mockImplementation(async (request, reply) => {
        for (const result of [
          { type: 'scrollback', serialized: 'ready' },
          { type: 'data', chunk: 'live' },
          { type: 'end' }
        ]) {
          reply(
            JSON.stringify({
              id: request.id,
              ok: true,
              result,
              streaming: true,
              _meta: { runtimeId: runtime.getRuntimeId() }
            })
          )
        }
      })

    await server.start()
    try {
      const metadata = readRuntimeMetadata(userDataPath)
      if (!metadata) {
        throw new Error('runtime metadata missing')
      }

      await expect(request(metadata, true)).resolves.toEqual([
        { type: 'scrollback', serialized: 'ready' },
        { type: 'data', chunk: 'live' },
        { type: 'end' }
      ])
      expect(dispatchStreaming).toHaveBeenCalledTimes(1)
      await expect(request(metadata, false)).resolves.toMatchObject({
        ok: false,
        error: { code: 'method_not_supported' }
      })
    } finally {
      await server.stop()
    }
  })
})

async function request(metadata: RuntimeMetadata, stream: boolean): Promise<unknown> {
  const transport = findTransport(metadata, 'unix', 'named-pipe')
  if (!transport) {
    throw new Error('local runtime transport missing')
  }
  const id = randomUUID()
  return await new Promise((resolve, reject) => {
    const socket = createConnection(transport.endpoint)
    let buffer = ''
    const results: unknown[] = []
    socket.setEncoding('utf8')
    socket.once('error', reject)
    socket.on('data', (chunk: string) => {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (!line.trim() || line.includes('"_keepalive"')) {
          continue
        }
        const response = JSON.parse(line) as {
          ok: boolean
          result?: unknown
          error?: unknown
        }
        if (!stream) {
          resolve(response)
          socket.end()
          return
        }
        if (!response.ok) {
          reject(response.error)
          socket.end()
          return
        }
        results.push(response.result)
      }
    })
    socket.once('close', () => {
      if (stream) {
        resolve(results)
      }
    })
    socket.once('connect', () => {
      socket.write(
        `${JSON.stringify({
          id,
          authToken: metadata.authToken,
          method: 'terminal.subscribe',
          params: { terminal: 'term-1' },
          ...(stream ? { stream: true } : {})
        })}\n`
      )
    })
  })
}
