import { Duplex, PassThrough, Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { RemoteCommandChannel } from '../../managed-server/install/remote-install-transport'
import { execCommand } from './remote-exec-command'

function answering(output: string): RemoteCommandChannel {
  const channel = new Duplex({
    emitClose: false,
    read() {},
    write: (_c, _e, done) => done()
  })
  Object.assign(channel, {
    stdin: new PassThrough(),
    stderr: new PassThrough(),
    close() {}
  })
  setImmediate(() => {
    channel.push(output)
    channel.push(null)
    channel.emit('close', 0)
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: stdin, stderr and close were assigned above.
  return channel as unknown as RemoteCommandChannel
}

describe('execCommand transport routing', () => {
  it('sends SSH the same command and options as before, through exec', async () => {
    const exec = vi.fn(async (_command: string, _options?: unknown) => answering('ok'))
    const conn = { exec, usesSystemSshTransport: () => false }
    const signal = new AbortController().signal
    await execCommand(conn, 'uname -sm', { signal })
    expect(exec).toHaveBeenCalledTimes(1)
    const [command, options] = exec.mock.calls[0] ?? ['', null]
    expect(options).toEqual({ signal })
    expect(command.split('\n').slice(1, -3)).toEqual(['uname -sm'])
    await execCommand(conn, 'true', { wrapCommand: false })
    expect(exec).toHaveBeenLastCalledWith('true', { wrapCommand: false })
  })

  it('uses a closed-stdin exec only when the caller has no stdin to send', async () => {
    const exec = vi.fn(async () => answering('direct'))
    const execWithClosedStdin = vi.fn(async () => answering('pooled'))
    const conn = {
      exec,
      execWithClosedStdin,
      usesSystemSshTransport: () => false
    }
    await expect(execCommand(conn, 'probe', { wrapCommand: false })).resolves.toBe('pooled')
    expect(execWithClosedStdin).toHaveBeenCalledWith('probe', {
      wrapCommand: false
    })
    await expect(
      execCommand(conn, 'cat', {
        wrapCommand: false,
        stdin: Readable.from(['x'])
      })
    ).resolves.toBe('direct')
    expect(exec).toHaveBeenCalledWith('cat', { wrapCommand: false })
  })
})
