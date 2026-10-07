import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshConnection } from './ssh-connection'
import { relaySocketNameForInstanceId } from './ssh-relay-instance-id'
import { windowsRelayPipePathsForSocketName } from './ssh-relay-endpoints'
import { getRemoteHostPlatform, joinRemotePath } from './ssh-remote-platform'

const { execCommand, countRelayPtysOverBridge } = vi.hoisted(() => ({
  execCommand: vi.fn(),
  countRelayPtysOverBridge: vi.fn()
}))

vi.mock('./ssh-relay-deploy-helpers', () => ({ execCommand }))
vi.mock('./ssh-relay-endpoint-pty-count', () => ({ countRelayPtysOverBridge }))
vi.mock('./ssh-remote-commands', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listRemoteInstallBaseDirsCommand: () => 'LIST'
}))
vi.mock('./ssh-host-relay-windows-inventory', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  windowsRelayInventoryCommand: () => 'INVENTORY',
  windowsPipeAccessCommand: (_host: unknown, _node: string, _home: string, pipes: string[]) =>
    `ACCESS ${pipes.join(' ')}`
}))
vi.mock('./ssh-relay-windows-launch-command', () => ({
  windowsRelayConnectCommand: (
    _host: unknown,
    _node: string,
    _dir: string,
    pipe: string,
    credential: string
  ) => `BRIDGE ${pipe} ${credential}`
}))

import { censusWindowsHostRelays } from './ssh-host-relay-windows-census'

// The census only hands the connection to the mocked exec and bridge.
const conn: SshConnection = Object.create(null)
const host = getRemoteHostPlatform('win32-x64')
const HOME = 'C:\\Users\\dev'
const VERSION = 'relay-0.1.0+aaaaaaaaaaaa'
const DIR = joinRemotePath(host, HOME, '.orca-remote', VERSION)
const sockOf = (targetId: string): string => relaySocketNameForInstanceId(targetId)
const pipesOf = (targetId: string): string[] =>
  windowsRelayPipePathsForSocketName(host, DIR, sockOf(targetId))
const bare = (pipe: string): string => pipe.slice('\\\\.\\pipe\\'.length)

let listing = ''
let inventory: unknown = null
let access: Record<string, string> = {}

const census = () =>
  censusWindowsHostRelays(conn, {
    host,
    remoteHome: HOME,
    targetId: 'desktop-a',
    nodePath: async () => 'C:\\node\\node.exe'
  })

describe('the connect-time relay census on a Windows host', () => {
  beforeEach(() => {
    listing = `${VERSION}\r\n`
    inventory = { pipes: [], dirs: { [VERSION]: { credentials: [], markers: {} } } }
    access = {}
    execCommand.mockReset().mockImplementation(async (_conn: unknown, command: string) => {
      if (command === 'LIST') {
        return listing
      }
      if (command === 'INVENTORY') {
        return JSON.stringify(inventory)
      }
      if (command.startsWith('ACCESS ')) {
        return JSON.stringify(access)
      }
      throw new Error(`unexpected ${command}`)
    })
    countRelayPtysOverBridge.mockReset().mockResolvedValue(0)
  })

  it('finds none on a host that never ran a relay', async () => {
    listing = ''
    await expect(census()).resolves.toEqual({ verdict: 'none', count: 0 })
  })

  // Two desktops, two target ids, one Windows account: B's live shell must block A's conversion.
  it("asks another desktop's relay on this account, with that relay's own credential", async () => {
    const [bPrimary] = pipesOf('desktop-b')
    inventory = {
      pipes: [bare(bPrimary)],
      dirs: { [VERSION]: { credentials: [`${sockOf('desktop-b')}.credential`], markers: {} } }
    }
    countRelayPtysOverBridge.mockResolvedValue(1)

    await expect(census()).resolves.toEqual({ verdict: 'live', count: 1 })
    expect(countRelayPtysOverBridge).toHaveBeenCalledWith(
      conn,
      `BRIDGE ${bPrimary} ${joinRemotePath(host, DIR, `${sockOf('desktop-b')}.credential`)}`,
      undefined,
      { wrapCommand: false }
    )
  })

  it('maps a pipe through its active-pipe marker when its credential is gone', async () => {
    const [, bFallback] = pipesOf('desktop-b')
    inventory = {
      pipes: [bare(bFallback)],
      dirs: {
        [VERSION]: {
          credentials: [],
          markers: { [`.windows-active-pipe-${sockOf('desktop-b')}`]: bFallback }
        }
      }
    }
    countRelayPtysOverBridge.mockResolvedValue(2)

    await expect(census()).resolves.toEqual({ verdict: 'live', count: 1 })
  })

  it("is unverifiable for a pipe no directory here accounts for, unless it is another account's", async () => {
    inventory = {
      pipes: ['orca-relay-0123456789abcdef0123', 'orca-relay-fedcba9876543210fedc'],
      dirs: { [VERSION]: { credentials: [], markers: {} } }
    }
    access = {
      '\\\\.\\pipe\\orca-relay-0123456789abcdef0123': 'EACCES',
      '\\\\.\\pipe\\orca-relay-fedcba9876543210fedc': 'ok'
    }
    await expect(census()).resolves.toEqual({ verdict: 'unverifiable', count: 1 })

    access['\\\\.\\pipe\\orca-relay-fedcba9876543210fedc'] = 'EPERM'
    await expect(census()).resolves.toEqual({ verdict: 'idle', count: 0 })
  })

  it.each([
    [
      'the inventory could not run',
      () =>
        execCommand.mockImplementation(async (_conn: unknown, command: string) => {
          if (command === 'LIST') {
            return listing
          }
          throw new Error('channel closed')
        })
    ],
    ['the pipe listing failed', () => (inventory = { pipes: null, dirs: {} })],
    [
      'a version directory could not be read',
      () => (inventory = { pipes: [], dirs: { [VERSION]: null } })
    ]
  ])('is unverifiable when %s', async (_label, arrange) => {
    arrange()
    await expect(census()).resolves.toMatchObject({ verdict: 'unverifiable' })
  })

  it('never converts under an owned pipe it cannot ask', async () => {
    const [aPrimary] = pipesOf('desktop-a')
    inventory = { pipes: [bare(aPrimary)], dirs: { [VERSION]: { credentials: [], markers: {} } } }
    countRelayPtysOverBridge.mockResolvedValue(null)

    await expect(census()).resolves.toEqual({ verdict: 'unverifiable', count: 1 })
  })

  it('reads relays that answer with no PTYs, or no relay pipes at all, as idle', async () => {
    const [aPrimary] = pipesOf('desktop-a')
    inventory = { pipes: [bare(aPrimary)], dirs: { [VERSION]: { credentials: [], markers: {} } } }
    await expect(census()).resolves.toEqual({ verdict: 'idle', count: 0 })

    inventory = { pipes: [], dirs: { [VERSION]: { credentials: [], markers: {} } } }
    await expect(census()).resolves.toEqual({ verdict: 'idle', count: 0 })
  })
})
