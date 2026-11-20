import { createServer, request, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  openClaudePermissionHookChannel,
  type ClaudePermissionHoldEnd
} from './claude-permission-hook-hold'

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve)))
  )
})

/** One held hook request; resolves the hook's reply, or null when the hook hung up. */
async function holdOne(budgetMs: number) {
  const ends: ClaudePermissionHoldEnd[] = []
  let channel: ReturnType<typeof openClaudePermissionHookChannel> | undefined
  const opened = new Promise<void>((resolve) => {
    const server = createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        channel = openClaudePermissionHookChannel(req, res, budgetMs)
        channel.onEnd((why) => ends.push(why))
        resolve()
      })
    })
    servers.push(server)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      const hookRequest = request({ port, host: '127.0.0.1', method: 'POST' }, (res) => {
        let body = ''
        res.on('data', (chunk) => (body += String(chunk)))
        res.on('end', () => settle(body))
      })
      hookRequest.on('error', () => settle(null))
      hookRequest.end('{}')
      hang = () => hookRequest.destroy()
    })
  })
  let settle: (body: string | null) => void = () => {}
  let hang = (): void => {}
  const reply = new Promise<string | null>((resolve) => (settle = resolve))
  await opened
  return { channel: channel!, ends, reply, hang: () => hang() }
}

describe('Claude permission hook channel', () => {
  it('writes one decision, and never a second', async () => {
    const held = await holdOne(60_000)
    expect(await held.channel.answer({ behavior: 'deny', message: 'use a script file' })).toBe(true)
    expect(await held.channel.answer({ behavior: 'allow' })).toBe(false)
    expect(JSON.parse((await held.reply) ?? '')).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: 'use a script file' }
      }
    })
    expect(held.ends).toEqual([])
  })

  it('reports a hook that hung up before any answer', async () => {
    const held = await holdOne(60_000)
    held.hang()
    await held.reply
    await vi.waitFor(() => expect(held.ends).toEqual(['hook-gone']))
    expect(await held.channel.answer({ behavior: 'allow' })).toBe(false)
  })
})
