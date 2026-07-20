import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { ClientChannel } from 'ssh2'
import { describe, expect, it, vi } from 'vitest'
import type { SshConnection } from '../ssh/ssh-connection'

const spawnMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({ spawn: spawnMock }))

import { HerdrCliHostTransport } from './herdr-cli-host-transport'
import { HerdrSshHostTransport } from './herdr-ssh-host-transport'

type MockChildProcess = Omit<ChildProcessWithoutNullStreams, 'stdout'> & {
  stdout: PassThrough
  kill: ReturnType<typeof vi.fn>
}

function createChildProcess(): MockChildProcess {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn()
  }) as unknown as MockChildProcess
}

function createSshChannel(): ClientChannel & { close: ReturnType<typeof vi.fn> } {
  return Object.assign(new EventEmitter(), {
    stderr: new EventEmitter(),
    writable: true,
    write: vi.fn(),
    end: vi.fn(),
    close: vi.fn()
  }) as unknown as ClientChannel & { close: ReturnType<typeof vi.fn> }
}

describe('Herdr terminal control transports', () => {
  it('closes a local controller instead of throwing on malformed frame JSON', () => {
    const child = createChildProcess()
    spawnMock.mockReturnValueOnce(child)
    const transport = new HerdrCliHostTransport({
      commandFor: (args) => ({ file: 'herdr', args })
    })
    const controller = transport.controlTerminal('session', 'pane', { cols: 80, rows: 24 })
    const onClosed = vi.fn()
    controller.onClosed(onClosed)

    child.stdout.write('{not-json}\n')

    expect(onClosed).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'terminal.closed',
        reason: expect.stringContaining('Invalid Herdr terminal event')
      })
    )
    expect(child.kill).toHaveBeenCalledTimes(1)
  })

  it('closes a remote controller instead of throwing on malformed frame JSON', async () => {
    const channel = createSshChannel()
    const connection = {
      exec: vi.fn().mockResolvedValue(channel)
    } as unknown as SshConnection
    const transport = new HerdrSshHostTransport(connection)
    const controller = transport.controlTerminal('session', 'pane', { cols: 80, rows: 24 })
    const onClosed = vi.fn()
    controller.onClosed(onClosed)
    await vi.waitFor(() => expect(connection.exec).toHaveBeenCalledTimes(1))

    channel.emit('data', Buffer.from('{not-json}\n'))

    expect(onClosed).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'terminal.closed',
        reason: expect.stringContaining('Invalid Herdr terminal event')
      })
    )
    expect(channel.close).toHaveBeenCalledTimes(1)
  })
})
