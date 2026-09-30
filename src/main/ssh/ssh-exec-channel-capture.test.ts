import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { captureSshExecChannel, type SshExecConnection } from './ssh-exec-channel-capture'

function fakeConnection(channel: EventEmitter): SshExecConnection {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: captureSshExecChannel only calls exec(), which this stub provides.
  return { exec: async () => channel } as unknown as SshExecConnection
}

describe('captureSshExecChannel', () => {
  it('keeps stderr bounded when a host floods it', async () => {
    const channel = Object.assign(new EventEmitter(), { stderr: new EventEmitter() })
    const pending = captureSshExecChannel(fakeConnection(channel), 'true', {
      timeoutMs: 5_000,
      timeoutMessage: 'timed out'
    })
    await Promise.resolve()
    await Promise.resolve()
    channel.stderr.emit('data', Buffer.alloc(200 * 1024, 'e'))
    channel.stderr.emit('data', Buffer.alloc(10, 'f'))
    channel.emit('exit', 1)
    channel.emit('close')
    const result = await pending
    expect(result.stderr.length).toBe(64 * 1024)
    expect(result.exitCode).toBe(1)
  })

  it('decodes a UTF-8 character split across two chunks', async () => {
    const channel = Object.assign(new EventEmitter(), { stderr: new EventEmitter() })
    const pending = captureSshExecChannel(fakeConnection(channel), 'true', {
      timeoutMs: 5_000,
      timeoutMessage: 'timed out'
    })
    await Promise.resolve()
    await Promise.resolve()
    const euro = Buffer.from('cost \u20ac5', 'utf8')
    const split = euro.indexOf(0xe2) + 2
    channel.emit('data', euro.subarray(0, split))
    channel.emit('data', euro.subarray(split))
    channel.stderr.emit('data', euro.subarray(0, split))
    channel.stderr.emit('data', euro.subarray(split))
    channel.emit('exit', 0)
    channel.emit('close')
    const result = await pending
    expect(result.stdout).toBe('cost \u20ac5')
    expect(result.stderr).toBe('cost \u20ac5')
  })
})
