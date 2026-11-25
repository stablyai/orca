import { PassThrough } from 'node:stream'
import { expect, it } from 'vitest'
import { execCommand } from './remote-exec-command'

it('returns the complete UTF-8 response within its combined stream budget', async () => {
  const transport = {
    usesSystemSshTransport: () => false,
    exec: async () => {
      const stdout = new PassThrough()
      const channel = Object.assign(stdout, {
        stdin: stdout,
        stderr: new PassThrough(),
        close: () => stdout.emit('close', 1)
      })
      setImmediate(() => {
        for (const byte of Buffer.from('豆包')) {
          channel.write(Buffer.from([byte]))
        }
        channel.stderr.write('!')
        channel.emit('close', 0)
      })
      return channel
    }
  }
  await expect(
    execCommand(transport, 'probe', { wrapCommand: false, maxOutputBytes: 7 })
  ).resolves.toBe('豆包')
  await expect(
    execCommand(transport, 'probe', { wrapCommand: false, maxOutputBytes: 6 })
  ).rejects.toThrow('output exceeded its size limit')
})
