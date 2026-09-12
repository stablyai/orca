import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ClientChannel } from 'ssh2'
import { describe, expect, it, vi } from 'vitest'
import { execCommand } from './ssh-relay-exec-command'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: spawnMock }))
vi.mock('./system-ssh-binary', () => ({ findSystemSsh: () => '/usr/bin/ssh' }))
import { spawnSystemSshCommand } from './system-ssh-command'

function fixture() {
  const channel = Object.assign(new PassThrough(), {
    stderr: new PassThrough(),
    close: vi.fn(() => channel.emit('close', 0))
  })
  const end = vi.spyOn(channel, 'end')
  const connection = {
    exec: vi.fn(async () => channel as unknown as ClientChannel),
    usesSystemSshTransport: () => false
  }
  return { channel, end, connection }
}

describe('bounded SSH command input', () => {
  it('preserves UTF-8 characters split across response chunks', async () => {
    const f = fixture()
    f.end.mockImplementation(() => {
      const bytes = Buffer.from('résumé')
      for (const byte of bytes) {
        f.channel.emit('data', Buffer.from([byte]))
      }
      f.channel.emit('close', 0)
      return f.channel
    })
    await expect(
      execCommand(f.connection, 'reader', { stdin: '', maxOutputBytes: 64 })
    ).resolves.toBe('résumé')
  })
  it('installs response listeners before delivering stdin', async () => {
    const f = fixture()
    f.end.mockImplementation(() => {
      f.channel.emit('data', Buffer.from('answer'))
      f.channel.emit('close', 0)
      return f.channel
    })
    await expect(execCommand(f.connection, 'reader', { stdin: 'secret' })).resolves.toBe('answer')
    expect(f.end).toHaveBeenCalledWith('secret')
    expect(f.connection.exec).toHaveBeenCalledWith('reader', {})
  })

  it('does not send input when admission aborts reentrantly', async () => {
    const f = fixture()
    const controller = new AbortController()
    await expect(
      execCommand(f.connection, 'reader', {
        stdin: 'secret',
        signal: controller.signal,
        beforeInput: () => {
          controller.abort()
        }
      })
    ).rejects.toThrow()
    expect(f.end).not.toHaveBeenCalled()
  })

  it('refuses admission failure before writing', async () => {
    const f = fixture()
    await expect(
      execCommand(f.connection, 'reader', {
        stdin: 'secret',
        beforeInput: () => {
          throw new Error('stale')
        }
      })
    ).rejects.toThrow('stale')
    expect(f.end).not.toHaveBeenCalled()
  })

  it('rejects combined byte overflow even when the command closes successfully', async () => {
    const f = fixture()
    f.end.mockImplementation(() => {
      f.channel.emit('data', Buffer.from('é'))
      f.channel.stderr.emit('data', Buffer.from('ab'))
      return f.channel
    })
    await expect(
      execCommand(f.connection, 'reader', {
        stdin: '',
        maxOutputBytes: 3
      })
    ).rejects.toThrow('output limit exceeded')
    expect(f.channel.close).toHaveBeenCalledOnce()
  })

  it('closes on a synchronous input write failure', async () => {
    const f = fixture()
    f.end.mockImplementation(() => {
      throw new Error('write failed')
    })
    await expect(execCommand(f.connection, 'reader', { stdin: 'secret' })).rejects.toThrow(
      'write failed'
    )
    expect(f.channel.close).toHaveBeenCalledOnce()
  })

  it('forwards end-of-input through the real system SSH facade', async () => {
    const proc = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn()
    })
    spawnMock.mockReturnValue(proc)
    let input = ''
    proc.stdin.on('data', (chunk) => {
      input += chunk.toString()
    })
    proc.stdin.on('finish', () => {
      proc.stdout.write('answer')
      proc.emit('close', 0)
    })
    const channel = spawnSystemSshCommand(
      { id: 't', label: 't', host: 'example.test', port: 22, username: 'u' },
      'reader'
    )
    await expect(
      execCommand({ exec: async () => channel, usesSystemSshTransport: () => true }, 'reader', {
        stdin: 'secret'
      })
    ).resolves.toBe('answer')
    expect(input).toBe('secret')
    expect(proc.stdin.writableFinished).toBe(true)
  })
})
