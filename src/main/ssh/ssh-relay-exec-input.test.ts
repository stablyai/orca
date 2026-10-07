import { EventEmitter } from 'node:events'
import { PassThrough, Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { execCommand } from './ssh-relay-exec-command'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: spawnMock }))
vi.mock('./system-ssh-binary', () => ({ findSystemSsh: () => '/usr/bin/ssh' }))
import { spawnSystemSshCommand } from './system-ssh-command'

function fakeSshProcess() {
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
  return { proc, input: () => input }
}

const target = { id: 't', label: 't', host: 'example.test', port: 22, username: 'u' }

describe('system SSH command input', () => {
  it('forwards end-of-input written to the facade to the ssh child', async () => {
    const { proc, input } = fakeSshProcess()
    const channel = spawnSystemSshCommand(target, 'reader')
    const finished = new Promise((resolve) => proc.stdin.once('finish', resolve))

    channel.end('secret')
    await finished

    expect(input()).toBe('secret')
    expect(proc.stdin.writableFinished).toBe(true)
  })

  it('streams command input through the real facade and returns the response', async () => {
    const { proc, input } = fakeSshProcess()
    const channel = spawnSystemSshCommand(target, 'reader')

    await expect(
      execCommand({ exec: async () => channel, usesSystemSshTransport: () => true }, 'reader', {
        stdin: Readable.from(['secret'])
      })
    ).resolves.toBe('answer')
    expect(input()).toBe('secret')
    expect(proc.stdin.writableFinished).toBe(true)
  })
})
