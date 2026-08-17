import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { HerdrSshHostTransport, HerdrSshSessionManager } from './herdr-ssh-session'
import type { SshConnection } from '../../../ssh/ssh-connection'

type FakeChannel = EventEmitter & {
  stderr: EventEmitter
  stdin: EventEmitter
  writable: boolean
  write: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  end: ReturnType<typeof vi.fn>
}

function createChannel(): FakeChannel {
  return Object.assign(new EventEmitter(), {
    stderr: new EventEmitter(),
    stdin: new EventEmitter(),
    writable: true,
    write: vi.fn(),
    close: vi.fn(),
    end: vi.fn()
  }) as unknown as FakeChannel
}

function createConnection(): { conn: SshConnection; exec: ReturnType<typeof vi.fn> } {
  const exec = vi.fn(() => Promise.resolve(createChannel()))
  return { conn: { exec } as unknown as SshConnection, exec }
}

const resolveHerdr = () => Promise.resolve('/mock/herdr')

describe('HerdrSshSessionManager', () => {
  it('runs a command and resolves its stdout', async () => {
    const { conn, exec } = createConnection()
    const manager = new HerdrSshSessionManager(conn, 2000, resolveHerdr)

    const channel = createChannel()
    exec.mockResolvedValue(channel)

    const promise = manager.run(['api', 'snapshot', '--json'])
    await new Promise((resolve) => setImmediate(resolve))
    channel.emit('data', Buffer.from('{"protocol":19}'))
    channel.emit('close', 0)
    await expect(promise).resolves.toContain('"protocol":19')
  })

  it('rejects on a nonzero exit with stderr', async () => {
    const { conn, exec } = createConnection()
    const manager = new HerdrSshSessionManager(conn, 2000, resolveHerdr)

    const channel = createChannel()
    exec.mockResolvedValue(channel)

    const promise = manager.run(['session', 'list'])
    await new Promise((resolve) => setImmediate(resolve))
    channel.emit('data', Buffer.from(''))
    channel.stderr.emit('data', Buffer.from('boom'))
    channel.emit('close', 1)
    await expect(promise).rejects.toThrow('boom')
  })

  it('starts a PowerShell Herdr server with separate ArgumentList items', async () => {
    const { conn, exec } = createConnection()
    const manager = new HerdrSshSessionManager(conn, 2000, resolveHerdr, {
      commandDialect: 'powershell'
    } as never)
    await (manager as unknown as { startServer(sessionName: string): Promise<void> }).startServer(
      'orca'
    )
    const command = String(exec.mock.calls[0]?.[0])
    const encoded = command.split('EncodedCommand ').at(1)
    const script = Buffer.from(encoded ?? '', 'base64').toString('utf16le')
    expect(script).toContain("'--session', 'orca', 'server'")
    expect(script).not.toContain("'--session orca server'")
  })
})

describe('HerdrSshHostTransport', () => {
  it('parses a JSON request response through the invocation', async () => {
    const { conn } = createConnection()
    const manager = new HerdrSshSessionManager(conn, 2000, resolveHerdr)
    const transport = new HerdrSshHostTransport(conn, 2000, resolveHerdr, undefined, manager)
    const run = vi
      .spyOn(manager, 'run')
      .mockResolvedValue(JSON.stringify({ id: '1', result: { count: 2 } }))

    const response = await transport.request('main', 'session.snapshot', {})
    expect(run).toHaveBeenCalled()
    expect(response).toEqual({ id: '1', result: { count: 2 } })
  })

  it('opens remote session control instead of copying the stdin parser', async () => {
    const { conn } = createConnection()
    const manager = new HerdrSshSessionManager(conn, 2000, resolveHerdr)
    const channel = createChannel()
    const open = vi.spyOn(manager, 'open').mockResolvedValue(channel as never)
    const transport = new HerdrSshHostTransport(conn, 2000, resolveHerdr, undefined, manager)
    const controller = transport.controlTerminal('orca', 'p1', { cols: 80, rows: 24 })
    controller.write('x')
    await vi.waitFor(() => {
      expect(channel.write).toHaveBeenCalled()
    })
    expect(open).toHaveBeenCalledWith([
      '--session',
      'orca',
      'terminal',
      'session',
      'control',
      'p1',
      '--cols',
      '80',
      '--rows',
      '24'
    ])
    expect(channel.write).toHaveBeenCalledWith('{"type":"terminal.input","text":"x"}\n')
    controller.release()
  })
})
