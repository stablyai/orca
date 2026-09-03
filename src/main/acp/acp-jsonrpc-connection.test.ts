import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'

import { AcpJsonRpcRequestError, openAcpJsonRpcConnection } from './acp-jsonrpc-connection'

function fakeAcpChild(script?: { initialize?: 'ok' | 'error' }): {
  child: EventEmitter & {
    pid: number | undefined
    stdin: PassThrough
    stdout: PassThrough
    stderr: PassThrough
    kill: () => boolean
  }
  requests: unknown[]
} {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const requests: unknown[] = []
  stdin.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (line.trim().length === 0) {
        continue
      }
      const message = JSON.parse(line) as { method?: string; id?: number }
      requests.push(message)
      if (message.method === 'initialize' && typeof message.id === 'number') {
        if (script?.initialize === 'error') {
          stdout.write(
            `${JSON.stringify({
              jsonrpc: '2.0',
              id: message.id,
              error: { code: -32000, message: 'initialize failed' }
            })}\n`
          )
          continue
        }
        stdout.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: { protocolVersion: 1, authMethods: [] }
          })}\n`
        )
      }
    }
  })
  const child = Object.assign(new EventEmitter(), {
    pid: undefined,
    stdin,
    stdout,
    stderr,
    kill: () => {
      child.emit('exit', 0, null)
      return true
    }
  })
  return { child, requests }
}

describe('ACP JSON-RPC connection', () => {
  it('initializes then answers a session/new request', async () => {
    const fake = fakeAcpChild()
    fake.child.stdin.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.trim().length === 0) {
          continue
        }
        const message = JSON.parse(line) as { method?: string; id?: number }
        if (message.method === 'session/new' && typeof message.id === 'number') {
          fake.child.stdout.write(
            `${JSON.stringify({
              jsonrpc: '2.0',
              id: message.id,
              result: { sessionId: 'sess-1', configOptions: [] }
            })}\n`
          )
        }
      }
    })
    const connection = await openAcpJsonRpcConnection(
      { command: 'grok', args: ['agent', 'stdio'] },
      {},
      () => fake.child as never
    )
    expect(fake.requests[0]).toMatchObject({ method: 'initialize' })
    expect(connection.initialize).toMatchObject({ protocolVersion: 1 })
    const created = await connection.request('session/new', { cwd: '/repo', mcpServers: [] })
    expect(created).toEqual({ sessionId: 'sess-1', configOptions: [] })
    await connection.close()
  })

  it('fails create when initialize returns an error', async () => {
    const fake = fakeAcpChild({ initialize: 'error' })
    await expect(
      openAcpJsonRpcConnection({ command: 'missing', args: [] }, {}, () => fake.child as never)
    ).rejects.toBeInstanceOf(AcpJsonRpcRequestError)
  })
})
