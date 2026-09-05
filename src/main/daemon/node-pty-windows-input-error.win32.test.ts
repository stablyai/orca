import type { Socket } from 'node:net'
import { spawn, type IPty } from 'node-pty'
import { describe, expect, it } from 'vitest'

type WindowsPtyInternals = IPty & {
  _agent: { inSocket: Socket }
  _socket: Socket
}

function waitForOutput(terminal: IPty, marker: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = ''
    const timeout = setTimeout(
      () => reject(new Error(`Timed out waiting for ${marker}; got ${output}`)),
      10_000
    )
    terminal.onData((chunk) => {
      output += chunk
      if (output.includes(marker)) {
        clearTimeout(timeout)
        resolve()
      }
    })
  })
}

function waitForExit(terminal: IPty): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Timed out waiting for the failed PTY to exit')),
      10_000
    )
    terminal.onExit(() => {
      clearTimeout(timeout)
      resolve()
    })
  })
}

describe.skipIf(process.platform !== 'win32')('node-pty Windows input errors', () => {
  it('retires only the failed PTY and keeps a witness writable after ConPTY EAGAIN', async () => {
    const uncaught: unknown[] = []
    const uncaughtListener = (error: unknown): void => {
      uncaught.push(error)
    }
    process.on('uncaughtException', uncaughtListener)

    let terminal: IPty | undefined
    let witness: IPty | undefined

    try {
      const options = {
        cwd: process.cwd(),
        env: process.env,
        useConptyDll: false
      }
      terminal = spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/q'], options)
      witness = spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/q'], options)
      const input = (terminal as WindowsPtyInternals)._agent.inSocket
      expect(input.listenerCount('error')).toBeGreaterThan(0)
      expect(() =>
        input.emit('error', Object.assign(new Error('write EAGAIN'), { code: 'EAGAIN' }))
      ).not.toThrow()
      await waitForExit(terminal)
      await new Promise((resolve) => setTimeout(resolve, 1_500))
      witness.write('echo ORCA_CONPTY_WITNESS\r')
      await waitForOutput(witness, 'ORCA_CONPTY_WITNESS')
      expect(uncaught).toEqual([])
    } finally {
      try {
        terminal?.kill()
      } catch {}
      try {
        witness?.kill()
      } catch {}
      // ConPTY's worker drains asynchronously; keep the guard installed through
      // the delayed close so cleanup cannot reintroduce an unhandled error.
      await new Promise((resolve) => setTimeout(resolve, 1_500))
      process.off('uncaughtException', uncaughtListener)
    }
  }, 20_000)

  it('ignores a late output EPIPE after the PTY has closed', async () => {
    const uncaught: unknown[] = []
    const uncaughtListener = (error: unknown): void => {
      uncaught.push(error)
    }
    process.on('uncaughtException', uncaughtListener)

    let terminal: IPty | undefined
    let exited = false
    try {
      terminal = spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/q'], {
        cwd: process.cwd(),
        env: process.env,
        useConptyDll: false
      })
      const output = (terminal as WindowsPtyInternals)._socket
      const exit = waitForExit(terminal).then(() => {
        exited = true
      })
      terminal.kill()
      await exit

      expect(() => {
        output.emit(
          'error',
          Object.assign(new Error('This socket has been ended by the other party'), {
            code: 'EPIPE'
          })
        )
      }).not.toThrow()
      expect(uncaught).toEqual([])
    } finally {
      if (!exited) {
        try {
          terminal?.kill()
        } catch {}
      }
      await new Promise((resolve) => setTimeout(resolve, 1_500))
      process.off('uncaughtException', uncaughtListener)
    }
  }, 20_000)

  it('contains an output EPIPE that races with PTY shutdown', async () => {
    const uncaught: unknown[] = []
    const uncaughtListener = (error: unknown): void => {
      uncaught.push(error)
    }
    process.on('uncaughtException', uncaughtListener)

    let terminal: IPty | undefined
    try {
      terminal = spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/q'], {
        cwd: process.cwd(),
        env: process.env,
        useConptyDll: false
      })
      const output = (terminal as WindowsPtyInternals)._socket
      const exit = waitForExit(terminal)
      expect(() => {
        output.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
        terminal?.kill()
      }).not.toThrow()
      await exit
      expect(uncaught).toEqual([])
    } finally {
      try {
        terminal?.kill()
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 1_500))
      process.off('uncaughtException', uncaughtListener)
    }
  }, 20_000)
})
