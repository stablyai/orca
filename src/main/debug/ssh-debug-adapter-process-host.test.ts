import type { ClientChannel } from 'ssh2'
import { describe, expect, it, vi } from 'vitest'
import type { SshConnection } from '../ssh/ssh-connection'
import { SshDebugAdapterProcessHost } from './ssh-debug-adapter-process-host'

function makeFakeChannel(): ClientChannel {
  return {
    write: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    close: vi.fn(),
    stderr: { on: vi.fn(), off: vi.fn() }
  } as unknown as ClientChannel
}

describe('SshDebugAdapterProcessHost', () => {
  it('resolves the connection by connectionId and execs the built remote command', async () => {
    const channel = makeFakeChannel()
    const exec = vi.fn().mockResolvedValue(channel)
    const connection = { exec } as unknown as SshConnection
    const getConnection = vi.fn().mockReturnValue(connection)

    const host = new SshDebugAdapterProcessHost('ssh-conn-1', getConnection)
    const proc = await host.spawn({
      type: 'node',
      request: 'launch',
      command: 'node',
      args: ['server.js'],
      cwd: '/srv/app'
    })

    expect(getConnection).toHaveBeenCalledWith('ssh-conn-1')
    expect(exec).toHaveBeenCalledWith("cd '/srv/app' && exec 'node' 'server.js'")
    expect(proc.stdin).toBe(channel)
    expect(proc.stdout).toBe(channel)
    expect(proc.stderr).toBe(channel.stderr)
  })

  it('kill() closes the underlying SSH channel', async () => {
    const channel = makeFakeChannel()
    const connection = { exec: vi.fn().mockResolvedValue(channel) } as unknown as SshConnection
    const host = new SshDebugAdapterProcessHost('ssh-conn-1', () => connection)

    const proc = await host.spawn({ type: 'node', request: 'launch', command: 'node', args: [] })
    proc.kill()

    expect(channel.close).toHaveBeenCalledTimes(1)
  })

  it('throws when no SSH connection is registered for the connectionId', async () => {
    const host = new SshDebugAdapterProcessHost('missing-conn', () => undefined)
    await expect(
      host.spawn({ type: 'node', request: 'launch', command: 'node', args: [] })
    ).rejects.toThrow(/No SSH connection/)
  })
})
