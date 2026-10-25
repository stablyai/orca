import { runProcess } from '@orca/process-host'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Script } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { WINDOWS_PIPE_ACCESS_JS, windowsPipesNotRunHere } from './ssh-host-relay-windows-inventory'

class ProbeSocket extends EventEmitter {
  destroyed = false

  destroy(): void {
    this.destroyed = true
  }
}

function startProbe(paths: readonly string[]) {
  const sockets: ProbeSocket[] = []
  const timers = new Map<number, { callback: () => void; delay: number }>()
  const output: string[] = []
  let nextTimer = 0
  new Script(WINDOWS_PIPE_ACCESS_JS).runInNewContext({
    require: (name: string) => {
      if (name !== 'net') {
        throw new Error(`Unexpected module ${name}`)
      }
      return {
        connect: () => {
          const socket = new ProbeSocket()
          sockets.push(socket)
          return socket
        }
      }
    },
    process: { argv: ['node', ...paths], stdout: { write: (text: string) => output.push(text) } },
    setTimeout: (callback: () => void, delay: number) => {
      const id = ++nextTimer
      timers.set(id, { callback, delay })
      return id
    },
    clearTimeout: (id: number) => timers.delete(id)
  })
  const expireProbe = (): void => {
    const first = timers.entries().next().value
    if (!first) {
      throw new Error('No pending probe deadline')
    }
    const [id, timer] = first
    expect(timer.delay).toBe(2000)
    timers.delete(id)
    timer.callback()
  }
  return { sockets, timers, output, expireProbe }
}

describe('Windows relay pipe probe lifetime', () => {
  it('releases the deadline after an accepted connection', () => {
    const probe = startProbe(['pipe-a'])
    expect(probe.timers.size).toBe(1)
    probe.sockets[0].emit('connect')
    expect(probe.output).toEqual(['{"pipe-a":"ok"}'])
    expect(probe.sockets[0].destroyed).toBe(true)
    expect(probe.timers.size).toBe(0)
  })

  it.each(['EACCES', 'EPERM', 'ENOENT', 'ECONNREFUSED'])(
    'releases the deadline after %s',
    (code) => {
      const probe = startProbe(['pipe-a'])
      probe.sockets[0].emit('error', { code })
      expect(probe.output).toEqual([JSON.stringify({ 'pipe-a': code })])
      expect(probe.sockets[0].destroyed).toBe(true)
      expect(probe.timers.size).toBe(0)
      const foreign = windowsPipesNotRunHere(probe.output[0])
      expect(foreign.has('pipe-a')).toBe(code !== 'ECONNREFUSED')
    }
  )

  it('retains one active deadline and preserves sequential answers', () => {
    const probe = startProbe(['pipe-a', 'pipe-b'])
    probe.sockets[0].emit('connect')
    expect(probe.output).toEqual([])
    expect(probe.sockets).toHaveLength(2)
    expect(probe.timers.size).toBe(1)
    probe.sockets[1].emit('error', { code: 'EACCES' })
    expect(probe.output).toEqual(['{"pipe-a":"ok","pipe-b":"EACCES"}'])
    expect(probe.timers.size).toBe(0)
    probe.sockets[0].emit('error', { code: 'ENOENT' })
    probe.sockets[1].emit('connect')
    expect(probe.output).toHaveLength(1)
  })

  it('keeps a real unanswered deadline and rejects later answers', () => {
    const probe = startProbe(['pipe-a', 'pipe-b'])
    probe.expireProbe()
    expect(probe.output).toEqual([])
    expect(probe.sockets[0].destroyed).toBe(true)
    expect(probe.timers.size).toBe(1)
    probe.sockets[1].emit('connect')
    expect(probe.output).toEqual(['{"pipe-a":"timeout","pipe-b":"ok"}'])
    expect(windowsPipesNotRunHere(probe.output[0])).toEqual(new Set())
    expect(probe.timers.size).toBe(0)
    probe.sockets[0].emit('connect')
    expect(probe.output).toHaveLength(1)
  })

  it('has no deadlines when no pipes need probing', () => {
    const probe = startProbe([])
    expect(probe.output).toEqual(['{}'])
    expect(probe.timers.size).toBe(0)
    expect(probe.sockets).toEqual([])
  })

  it('lets the actual Node probe exit after answering live and missing pipes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-pipe-'))
    const socketPath =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\orca-test-${randomUUID()}`
        : join(dir, 'probe.sock')
    const missingPath = `${socketPath}-missing`
    const server = createServer((socket) => socket.on('error', () => socket.destroy()))
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
    try {
      const result = await runProcess({
        program: process.execPath,
        args: ['-e', WINDOWS_PIPE_ACCESS_JS, socketPath, missingPath],
        timeoutMs: 1500
      })
      expect(result.stdout).toBe(JSON.stringify({ [socketPath]: 'ok', [missingPath]: 'ENOENT' }))
      expect(result.timedOut).toBe(false)
      expect(result.code).toBe(0)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
