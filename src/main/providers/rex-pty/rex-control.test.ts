import { describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { mkdtemp, rm, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { z } from 'zod'
import { RexControl } from './rex-control'
import {
  rexControlReceiveBudget,
  rexControlWireBudget,
  rexPendingRpcBudget
} from './rex-memory-budget'

describe.skipIf(process.platform === 'win32')('Rex control transport', () => {
  it('correlates concurrent replies, validates payloads and never retries an unsettled request', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orca-rex-test-'))
    const path = join(dir, 's')
    const server = createServer()
    const wss = new WebSocketServer({ server })
    let control: RexControl | undefined
    const requests: string[] = []
    const request = z.object({ type: z.literal('request'), id: z.string(), method: z.string() })
    const value = z.object({ value: z.string() })
    wss.on('connection', (socket) => {
      let firstId: string | undefined
      socket.on('message', (raw) => {
        const msg: unknown = JSON.parse(raw.toString())
        if (typeof msg === 'object' && msg !== null && 'type' in msg && msg.type === 'hello') {
          socket.send(JSON.stringify({ type: 'welcome', api_revision: 24 }))
          return
        }
        const r = request.parse(msg)
        requests.push(r.method)
        const reply = (id: string, payload: unknown) =>
          socket.send(JSON.stringify({ type: 'response', id, payload }))
        if (r.method === 'first') {
          firstId = r.id
        } else if (r.method === 'second') {
          reply(r.id, { value: 'second' })
          if (firstId) {
            reply(firstId, { value: 'first' })
          }
        } else if (r.method === 'malformed') {
          reply(r.id, { value: 3 })
        } else {
          socket.terminate()
        }
      })
    })
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(path, resolve)
      })
      await chmod(path, 0o600)
      control = await RexControl.connect(path)
      const first = control.call('first', {}, value.parse)
      const second = control.call('second', {}, value.parse)
      await expect(Promise.all([first, second])).resolves.toEqual([
        { value: 'first' },
        { value: 'second' }
      ])
      await expect(control.call('malformed', {}, value.parse)).rejects.toThrow()
      await expect(control.call('lost', {})).rejects.toThrow('connection lost')
      expect(requests).toEqual(['first', 'second', 'malformed', 'lost'])
    } finally {
      control?.close()
      for (const socket of wss.clients) {
        socket.terminate()
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()))
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(dir, { recursive: true, force: true })
    }
  })

  it.each(['valid', 'wrong-client', 'not-resumed', 'close'] as const)(
    'reconciles control identity without replaying pending RPCs: %s',
    async (mode) => {
      const dir = await mkdtemp(join(tmpdir(), 'rex-control-resume-'))
      const path = join(dir, 's')
      const server = createServer()
      const wss = new WebSocketServer({ server })
      let control: RexControl | undefined
      let resumePeer: WebSocket | undefined
      const requests: string[] = []
      let connections = 0
      const welcome = (id: string, resumed: boolean) =>
        JSON.stringify({
          type: 'welcome',
          api_revision: 24,
          client: { id, reconnect_token: 'fixture-token', resumed }
        })
      wss.on('connection', (socket) => {
        const attempt = ++connections
        socket.on('message', (raw) => {
          const message = JSON.parse(raw.toString())
          if (message.type === 'hello') {
            if (attempt === 1) {
              socket.send(welcome('fixture-client', false))
            } else {
              expect(message.reconnect_token).toBe('fixture-token')
              resumePeer = socket
              if (mode !== 'close') {
                socket.send(
                  welcome(
                    mode === 'wrong-client' ? 'different-client' : 'fixture-client',
                    mode !== 'not-resumed'
                  )
                )
              }
            }
          } else {
            requests.push(message.method)
            if (message.method === 'lost') {
              socket.terminate()
            } else {
              socket.send(JSON.stringify({ type: 'response', id: message.id, payload: 'ok' }))
            }
          }
        })
      })
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject)
          server.listen(path, resolve)
        })
        await chmod(path, 0o600)
        control = await RexControl.connect(path)
        await expect(control.call('lost', {})).rejects.toThrow('connection lost')
        await vi.waitFor(() => expect(resumePeer).toBeDefined())
        if (mode === 'close') {
          const pending = control.call('after', {})
          const checked = expect(pending).rejects.toThrow('Rex control closed')
          void checked.catch(() => undefined)
          control.close()
          await vi.waitFor(
            () => {
              expect(rexControlWireBudget.usage()).toEqual({ bytes: 0, objects: 0 })
              expect(rexControlReceiveBudget.usage()).toEqual({ bytes: 0, objects: 0 })
              expect(rexPendingRpcBudget.usage()).toEqual({ bytes: 0, objects: 0 })
            },
            { timeout: 1000 }
          )
          await checked
        } else if (mode === 'valid') {
          await expect(control.call('after', {})).resolves.toBe('ok')
        } else {
          await vi.waitFor(() => expect(control!.isClosed).toBe(true))
          await expect(control.call('after', {})).rejects.toThrow('Rex control closed')
        }
        expect(connections).toBe(2)
        expect(requests).toEqual(mode === 'valid' ? ['lost', 'after'] : ['lost'])
      } finally {
        control?.close()
        for (const socket of wss.clients) {
          socket.terminate()
        }
        await new Promise<void>((resolve) => wss.close(() => resolve()))
        await new Promise<void>((resolve) => server.close(() => resolve()))
        await rm(dir, { recursive: true, force: true })
      }
    }
  )
})
