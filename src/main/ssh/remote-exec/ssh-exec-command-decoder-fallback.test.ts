import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { runProcess } from '@orca/process-host'
import { wrapRemoteCommandForPosixShell } from './ssh-posix-command-wrapper'
import type { SshExecOptions } from '../connection/ssh-exec-options'
import { execCommand } from './remote-exec-command'

type HostOptions = {
  /** PATH on the host; '' leaves only shell builtins, so no base64 or gzip. */
  path?: string
}

/** Exercise the actual transport wrapper through real /bin/sh. */
function host(options: HostOptions = {}) {
  const exec = vi.fn()
  exec.mockImplementation(async (command: string, execOptions?: SshExecOptions) => {
    const remote = wrapRemoteCommandForPosixShell(command, {
      compress: execOptions?.compressCommand === true
    })
    const result = await runProcess({
      program: '/bin/sh',
      args: ['-c', remote],
      env: { ...process.env, PATH: options.path ?? process.env.PATH ?? '' }
    })
    const channel = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stderr: new EventEmitter(),
      close: () => {}
    })
    setImmediate(() => {
      channel.emit('data', Buffer.from(result.stdout))
      channel.stderr.emit('data', Buffer.from(result.stderr))
      channel.emit('close', result.code ?? 1)
    })
    return channel
  })
  return { exec, usesSystemSshTransport: () => false }
}

const LONG = `printf '%s' ran # ${'padding '.repeat(2_000)}`

describe.skipIf(process.platform === 'win32')(
  'a long command on hosts that cannot decode it (#30491)',
  () => {
    it('resends it uncompressed once, then sends that host every command plain', async () => {
      const conn = host({ path: '' })

      await expect(execCommand(conn, LONG)).resolves.toBe('ran')
      await expect(execCommand(conn, LONG)).resolves.toBe('ran')

      expect(conn.exec.mock.calls.map(([, options]) => options?.compressCommand)).toEqual([
        true,
        false,
        false
      ])
    })
  }
)
