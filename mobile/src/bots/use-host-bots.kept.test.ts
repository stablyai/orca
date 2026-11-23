import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BOTS_MOBILE_RUNTIME_CAPABILITY } from '../../../src/shared/bot-runtime-capabilities'
import type { MobileRelayHost } from '../../../src/shared/remote-runtime/relay/mobile-relay-hosts-contract'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { RpcResponse } from '../transport/rpc/rpc-wire-types'
import type { HostBotListing } from './host-bot-listing'

// The device store outlives the app process, as the phone's disk does.
const disk = vi.hoisted(
  (): { values: Map<string, string>; writes: number; gate: Promise<void> | null } => ({
    values: new Map(),
    writes: 0,
    // While set, a read waits on it, as the first one waits on the store's key.
    gate: null
  })
)
// The server's Up next count, which moves with every bot turn.
let unseen = 0

vi.mock('../device-store/device-store', () => ({
  processDeviceStore: () => ({
    read: async (hostId: string, table: string, keys: readonly string[]) => {
      await disk.gate
      return {
        status: 'ok',
        values: keys.map((key) => disk.values.get(`${hostId}|${table}|${key}`) ?? null)
      }
    },
    write: async (
      hostId: string,
      table: string,
      ops: readonly { key: string; value: string | null }[]
    ) => {
      disk.writes += 1
      for (const { key, value } of ops) {
        if (value === null) {
          disk.values.delete(`${hostId}|${table}|${key}`)
        } else {
          disk.values.set(`${hostId}|${table}|${key}`, value)
        }
      }
      return { written: true }
    }
  })
}))
// Every server is reached through the paired desktop's own client here.
vi.mock('../worktree/execution-hosts/execution-host-scoped-rpc-client', () => ({
  rpcClientForExecutionHost: (client: RpcClient) => client
}))

const BOT = {
  id: 'scout',
  name: 'windows bot 2',
  hostId: 'local',
  folder: 'scout',
  folderWorkspaceId: 'scout-home',
  agent: 'claude',
  avatar: null,
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  linear: null,
  github: null,
  chatSessionId: null,
  createdAt: 1,
  updatedAt: 1
}

function desktop(bots: unknown[]): RpcClient {
  const results: Record<string, unknown> = {
    'status.get': { capabilities: [BOTS_MOBILE_RUNTIME_CAPABILITY] },
    'bots.list': { bots, botsEnabled: true, hideBotCreatedWorkspaces: true },
    'worktree.lineageList': { lineage: {}, workspaceLineage: {} },
    'bots.groups.list': { groups: [] }
  }
  return {
    sendRequest: async (method: string): Promise<RpcResponse> => ({
      id: method,
      ok: true,
      result:
        method === 'bots.upNext.unseen' ? { unseen: { scout: unseen } } : (results[method] ?? {})
    }),
    subscribe: () => () => {},
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }
}

function server(relay: MobileRelayHost['relay']): MobileRelayHost {
  return {
    hostId: 'runtime:g16',
    label: 'g16',
    health: relay === 'ready' ? 'available' : 'disconnected',
    relay
  }
}

/** One app launch: fresh modules, the same disk. */
async function launch(client: RpcClient, serverHosts: readonly MobileRelayHost[]) {
  vi.resetModules()
  const { useHostBots } = await import('./use-host-bots')
  const seen: { current: readonly HostBotListing[] } = { current: [] }
  const props = {
    client,
    pairedHostId: 'mac',
    connState: 'connected',
    hostCapabilities: [],
    hostLabel: 'Mac',
    serverHosts,
    rowsKey: '',
    changeKey: 0,
    pairedChangeKey: 0
  } as const
  function Reader(next: { serverHosts: readonly MobileRelayHost[]; changeKey: number }): null {
    seen.current = useHostBots({ ...props, ...next })
    return null
  }
  let renderer: ReturnType<typeof create> | undefined
  let changeKey = 0
  await act(async () => {
    renderer = create(createElement(Reader, { serverHosts, changeKey }))
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
  return {
    seen,
    // A reconnect or foreground: every host reads again.
    rerender: async (next: readonly MobileRelayHost[]) => {
      changeKey += 1
      await act(async () => {
        renderer?.update(createElement(Reader, { serverHosts: next, changeKey }))
      })
    },
    settle: async () => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000)
      })
    },
    unmount: () => act(() => renderer?.unmount())
  }
}

function server16(listings: readonly HostBotListing[]): HostBotListing | undefined {
  return listings.find((listing) => listing.hostId === 'runtime:g16')
}

describe('useHostBots across a phone restart', () => {
  afterEach(() => vi.useRealTimers())

  it("lists a down server's bots from its kept listing, dimmed, until the desktop stops listing it", async () => {
    vi.useFakeTimers()
    const first = await launch(desktop([BOT]), [server('ready')])
    expect(server16(first.seen.current)).toMatchObject({ kind: 'listed', unseen: { scout: 0 } })
    await first.settle()
    expect(disk.writes).toBe(1)
    // A read where only the Up next count moved writes nothing.
    unseen += 3
    await first.rerender([{ ...server('ready') }])
    await first.settle()
    expect(server16(first.seen.current)).toMatchObject({ unseen: { scout: 3 } })
    expect(disk.writes).toBe(1)
    first.unmount()

    const restarted = await launch(desktop([]), [server('unavailable')])
    expect(server16(restarted.seen.current)).toMatchObject({
      kind: 'listed',
      offline: 'Offline',
      bots: [expect.objectContaining({ id: 'scout', name: 'windows bot 2' })]
    })
    // What was kept is not written back.
    await restarted.settle()
    expect(disk.writes).toBe(1)
    // Unpaired on the desktop: its kept listing goes.
    await restarted.rerender([{ ...server('ready'), hostId: 'runtime:other', label: 'other' }])
    await restarted.settle()
    restarted.unmount()

    const again = await launch(desktop([]), [server('unavailable')])
    expect(server16(again.seen.current)).toMatchObject({ kind: 'unreachable' })
    again.unmount()
  })

  it('seeds a down server whose kept read was still out when another server was listed', async () => {
    vi.useFakeTimers()
    const first = await launch(desktop([BOT]), [server('ready')])
    await first.settle()
    first.unmount()

    let open = (): void => {}
    disk.gate = new Promise((resolve) => (open = resolve))
    const other = { ...server('unavailable'), hostId: 'runtime:other', label: 'other' } as const
    const restarted = await launch(desktop([]), [server('unavailable')])
    // The desktop's list grows while the first kept read waits on the store.
    await restarted.rerender([server('unavailable'), other])
    open()
    disk.gate = null
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(server16(restarted.seen.current)).toMatchObject({
      kind: 'listed',
      offline: 'Offline'
    })
    restarted.unmount()
  })
})
