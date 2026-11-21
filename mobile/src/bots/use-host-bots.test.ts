import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BOTS_CREATE_RUNTIME_CAPABILITY,
  BOTS_MOBILE_RUNTIME_CAPABILITY
} from '../../../src/shared/bot-runtime-capabilities'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { RpcResponse } from '../transport/rpc/rpc-wire-types'
import { HOST_REFRESH_FALLBACK_MS } from '../worktree/execution-hosts/host-worktree-refresh'
import type { HostBotListing } from './host-bot-sections'
import { readHostBotListing, useHostBots } from './use-host-bots'

const LISTING = { bots: [], botsEnabled: true, hideBotCreatedWorkspaces: true }

function host(capabilities: string[], botsList: unknown = LISTING) {
  const methods: string[] = []
  const results: Record<string, unknown> = {
    'status.get': { capabilities },
    'bots.list': botsList,
    'worktree.lineageList': { lineage: {}, workspaceLineage: {} },
    'bots.groups.list': { groups: [] }
  }
  const client: RpcClient = {
    sendRequest: async (method: string): Promise<RpcResponse> => {
      methods.push(method)
      return { id: method, ok: true, result: results[method] ?? {} }
    },
    subscribe: () => () => {},
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }
  return { client, methods }
}

describe('readHostBotListing', () => {
  it('asks a host without bots for phones for no lineage', async () => {
    const { client, methods } = host([])
    const target = {
      hostId: 'local',
      hostLabel: 'Mac',
      client,
      key: 'old\nlocal',
      relaysCreate: true
    } as const
    await readHostBotListing(target, new Map(), false)
    expect(methods).not.toContain('worktree.lineageList')
  })

  it('offers a new bot only while bots are on and the route takes bots.create', async () => {
    const capabilities = [BOTS_MOBILE_RUNTIME_CAPABILITY, BOTS_CREATE_RUNTIME_CAPABILITY]
    const on = host(capabilities).client
    const off = host(capabilities, { ...LISTING, botsEnabled: false }).client
    const read = (client: RpcClient, key: string, relaysCreate = true) =>
      readHostBotListing(
        { hostId: 'local', hostLabel: 'Mac', client, key, relaysCreate },
        new Map(),
        false
      )
    expect(await read(on, 'create-on\nlocal')).not.toHaveProperty('createRefusal')
    expect(await read(off, 'create-off\nlocal')).toMatchObject({ createRefusal: 'bots-off' })
    // A host whose build predates bots.create from a phone, the paired desktop included.
    const old = host([BOTS_MOBILE_RUNTIME_CAPABILITY]).client
    expect(await read(old, 'create-old\nlocal')).toMatchObject({ createRefusal: 'update' })
    // A server reached through a paired desktop too old to pass bots.create on.
    const relayed = host(capabilities).client
    expect(await read(relayed, 'create-relayed\nlocal', false)).toMatchObject({
      createRefusal: 'update-desktop'
    })
  })
})

const ROOM = {
  id: 'room',
  name: 'Room',
  hostId: 'local',
  revision: 1,
  folder: 'room',
  folderWorkspaceId: 'room-home',
  createdAt: 0,
  members: [],
  replyMode: { kind: 'all' }
}

describe('useHostBots', () => {
  afterEach(() => vi.useRealTimers())

  it('lists the bots when the groups read fails, then reads the groups again', async () => {
    vi.useFakeTimers()
    const { client } = host([BOTS_MOBILE_RUNTIME_CAPABILITY])
    const send = client.sendRequest
    const workspaceLineage = {
      'folder:worker': {
        childWorkspaceKey: 'folder:worker',
        parentWorkspaceKey: 'folder:room-home',
        origin: 'orchestration'
      }
    }
    let groupReads = 0
    client.sendRequest = async (method, params) => {
      if (method === 'worktree.lineageList') {
        return { id: method, ok: true, result: { lineage: {}, workspaceLineage } }
      }
      if (method === 'bots.groups.list') {
        groupReads += 1
        if (groupReads === 1) {
          throw new Error('request_timeout')
        }
        return { id: method, ok: true, result: { groups: [ROOM] } }
      }
      return send(method, params)
    }
    const seen: { current: readonly HostBotListing[] } = { current: [] }
    // Stable props, as the host screen passes them, so only the hook's own retry reads again.
    const props = {
      client,
      pairedHostId: 'groups-retry',
      connState: 'connected',
      hostCapabilities: [],
      hostLabel: 'Mac',
      serverHosts: [],
      rowsKey: '',
      changeKey: 0,
      pairedChangeKey: 0
    } as const
    function Reader(): null {
      seen.current = useHostBots(props)
      return null
    }
    let renderer: ReturnType<typeof create> | undefined
    await act(async () => {
      renderer = create(createElement(Reader))
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(seen.current[0]).toMatchObject({ kind: 'listed', workspaceLineage })
    expect(seen.current[0]).not.toHaveProperty('groups')
    // No reconnect, foreground or workspace change: the retry alone reads the groups.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOST_REFRESH_FALLBACK_MS)
    })
    expect(seen.current[0]).toMatchObject({
      groups: [expect.objectContaining({ folderWorkspaceId: 'room-home' })]
    })
    act(() => renderer?.unmount())
  })
})
