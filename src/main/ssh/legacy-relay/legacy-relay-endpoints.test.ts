import type * as ExecCommandModule from '../remote-exec/remote-exec-command'
import { describe, expect, it, vi } from 'vitest'
import type { SshConnection } from '../ssh-connection'
import { relaySocketNameForInstanceId } from './ssh-relay-instance-id'
import { windowsRelayPipePathsForSocketName } from './ssh-relay-endpoints'
import { getRemoteHostPlatform, joinRemotePath } from '../ssh-remote-platform'

const { execCommand } = vi.hoisted(() => ({ execCommand: vi.fn() }))
vi.mock('../remote-exec/remote-exec-command', async (importOriginal) => ({
  ...(await importOriginal<typeof ExecCommandModule>()),
  execCommand
}))
vi.mock('../ssh-remote-platform-detection', () => ({
  detectRemoteHostPlatform: async () => getRemoteHostPlatform('win32-x64')
}))
vi.mock('./ssh-host-relay-windows-census', () => ({
  windowsCensusNodePath: async () => 'C:\\node\\node.exe'
}))
vi.mock('./ssh-host-relay-windows-inventory', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  windowsRelayInventoryCommand: () => 'INVENTORY'
}))
vi.mock('./ssh-relay-windows-launch-command', () => ({
  windowsRelayConnectCommand: (_h: unknown, _n: string, _d: string, pipe: string) =>
    `BRIDGE ${pipe}`
}))

import {
  legacyRelayEndpointListCommand,
  listLegacyRelayEndpoints,
  posixLegacyRelayConnectCommand
} from './legacy-relay-endpoints'

const conn: SshConnection = Object.create(null)

describe('legacy relay endpoints', () => {
  it('runs the relay’s own --connect from its version directory, never a launch', () => {
    const command = posixLegacyRelayConnectCommand(
      '/home/me',
      '/usr/bin/node',
      '/home/me/.orca-remote/relay-0.1.0+abc/relay-1234.sock'
    )
    expect(command).toBe(
      "cd '/home/me/.orca-remote/relay-0.1.0+abc' && '/usr/bin/node' relay.js --connect " +
        "--sock-path '/home/me/.orca-remote/relay-0.1.0+abc/relay-1234.sock' " +
        "--credential-file '/home/me/.orca-remote/relay-0.1.0+abc/relay-1234.sock.credential'"
    )
    expect(command).not.toContain('--detached')
  })

  it('reaches a socket a long $HOME moved under /tmp through its home version directory', () => {
    expect(
      posixLegacyRelayConnectCommand(
        '/home/a-very-long-name',
        'node',
        '/tmp/.orca-relay-1000/relay-0.1.0+abc/relay-1234.sock'
      )
    ).toBe(
      "cd '/home/a-very-long-name/.orca-remote/relay-0.1.0+abc' && 'node' relay.js --connect " +
        "--sock-path '/tmp/.orca-relay-1000/relay-0.1.0+abc/relay-1234.sock' " +
        "--credential-file '/home/a-very-long-name/.orca-remote/relay-0.1.0+abc/relay-1234.sock.credential'"
    )
  })

  it('names no build for a socket outside a version directory', () => {
    expect(posixLegacyRelayConnectCommand('/home/me', 'node', '/tmp/relay.sock')).toBeNull()
  })

  it('lists only this target’s sockets, read-only', () => {
    const command = legacyRelayEndpointListCommand('/home/me', 'relay-1234.sock')
    expect(command).toContain('"$base"/relay-*/\'relay-1234.sock\'')
    expect(command).toContain('"$short_base"/relay-*/\'relay-1234.sock\'')
    expect(command).not.toMatch(/\brm\b|\bkill\b|--detached/)
  })
})

describe('legacy relay endpoints on a Windows host', () => {
  const host = getRemoteHostPlatform('win32-x64')
  const version = 'relay-0.1.0+aaaaaaaaaaaa'
  const dir = joinRemotePath(host, 'C:\\Users\\dev', '.orca-remote', version)
  const ours = relaySocketNameForInstanceId('desktop-a')
  const theirs = relaySocketNameForInstanceId('desktop-b')
  const [ourPipe] = windowsRelayPipePathsForSocketName(host, dir, ours)
  const [theirPipe] = windowsRelayPipePathsForSocketName(host, dir, theirs)
  const bare = (pipe: string): string => pipe.slice('\\\\.\\pipe\\'.length)
  const inventory = (pipes: string[]) =>
    JSON.stringify({
      pipes: pipes.map(bare),
      dirs: {
        [version]: { credentials: [`${ours}.credential`, `${theirs}.credential`], markers: {} }
      }
    })

  it('bridges only this target’s pipe, through its relay’s own --connect', async () => {
    execCommand.mockImplementation(async (_c: unknown, command: string) =>
      command === 'INVENTORY' ? inventory([ourPipe, theirPipe]) : 'C:\\Users\\dev'
    )
    await expect(listLegacyRelayEndpoints(conn, 'desktop-a')).resolves.toMatchObject({
      kind: 'listed',
      exhaustive: true,
      endpoints: [{ endpoint: ourPipe, connectCommand: `BRIDGE ${ourPipe}`, wrapCommand: false }]
    })
  })

  it('never reads a pipe no directory accounts for as proof of absence', async () => {
    execCommand.mockImplementation(async (_c: unknown, command: string) =>
      command === 'INVENTORY'
        ? JSON.stringify({ pipes: [bare(ourPipe), 'orca-relay-ffffffffffffffffffff'], dirs: {} })
        : 'C:\\Users\\dev'
    )
    await expect(listLegacyRelayEndpoints(conn, 'desktop-a')).resolves.toMatchObject({
      kind: 'listed',
      exhaustive: false,
      endpoints: []
    })
  })
})
