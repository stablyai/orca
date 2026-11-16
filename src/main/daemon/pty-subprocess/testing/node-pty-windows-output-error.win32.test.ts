import type { Socket } from 'node:net'
import { spawn, type IPty } from 'node-pty'
import { describe, expect, it } from 'vitest'

type WindowsPtyInternals = IPty & { _socket: Socket; _writable: boolean }

function isWindowsPtyInternals(terminal: IPty): terminal is WindowsPtyInternals {
  return '_socket' in terminal && '_writable' in terminal
}

describe.skipIf(process.platform !== 'win32')('node-pty Windows output pipe errors', () => {
  it('retires only the failed PTY on an unmapped pipe error even without a consumer listener', async () => {
    const uncaught: unknown[] = []
    const uncaughtListener = (error: unknown): void => {
      uncaught.push(error)
    }
    process.on('uncaughtException', uncaughtListener)

    let terminal: IPty | undefined
    try {
      // Warmup and spawn-health PTYs attach no 'error' listener; upstream rethrew when fewer than two.
      terminal = spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/q'], {
        cwd: process.cwd(),
        env: process.env,
        useConptyDll: true
      })
      if (!isWindowsPtyInternals(terminal)) {
        throw new Error('node-pty WindowsTerminal internals changed')
      }
      const output = terminal._socket
      expect(output.listenerCount('error')).toBeLessThan(2)
      // libuv reports Win32 errors it cannot map (#33350) as UNKNOWN.
      expect(() =>
        output.emit('error', Object.assign(new Error('write UNKNOWN'), { code: 'UNKNOWN' }))
      ).not.toThrow()
      expect(terminal._writable).toBe(false)
      expect(uncaught).toEqual([])
    } finally {
      try {
        terminal?.kill()
      } catch {}
      // Keep the guard through async ConPTY close so cleanup cannot leak an unhandled error.
      await new Promise((resolve) => setTimeout(resolve, 1_500))
      process.off('uncaughtException', uncaughtListener)
    }
  }, 20_000)
})
