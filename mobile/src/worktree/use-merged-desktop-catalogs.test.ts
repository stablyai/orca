import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { getProvenCachedWorktrees } from '../cache/worktree-cache'
import type { RpcClient } from '../transport/rpc-client'
import type { HostProfile, RpcResponse } from '../transport/types'
import {
  useMergedDesktopCatalogs,
  type DesktopClient,
  type MergedDesktopCatalogs
} from './use-merged-desktop-catalogs'
import type { Worktree } from './workspace-list-types'

type PendingRequest = {
  method: string
  resolve: (response: RpcResponse) => void
}

type TestClient = {
  rpc: RpcClient
  pending: PendingRequest[]
  emit: (payload: unknown) => void
}

function success(result: unknown): RpcResponse {
  return { id: 'response', ok: true, result, _meta: { runtimeId: 'runtime' } }
}

function failure(): RpcResponse {
  return {
    id: 'response',
    ok: false,
    error: { code: 'offline', message: 'offline' },
    _meta: { runtimeId: 'runtime' }
  }
}

function row(id: string): Worktree {
  return {
    workspaceKind: 'git',
    worktreeId: id,
    repoId: 'repo-1',
    repo: 'orca',
    branch: 'main',
    displayName: id,
    path: `/tmp/${id}`,
    liveTerminalCount: 0,
    hasAttachedPty: false,
    preview: '',
    unread: false,
    isPinned: false,
    linkedPR: null
  }
}

function makeClient(): TestClient {
  const pending: PendingRequest[] = []
  let listener: (payload: unknown) => void = () => {}
  const rpc = {
    sendRequest: (method: string) =>
      new Promise<RpcResponse>((resolve) => pending.push({ method, resolve })),
    subscribe: (_method: string, _params: unknown, next: (payload: unknown) => void) => {
      listener = next
      return () => {
        listener = () => {}
      }
    }
  } as unknown as RpcClient
  return { rpc, pending, emit: (payload) => listener(payload) }
}

function desktop(
  hostId: string,
  client: TestClient,
  state: DesktopClient['state'],
  hostName = hostId.toUpperCase()
): DesktopClient {
  return { hostId, hostName, client: client.rpc, state }
}

function profile(id: string): HostProfile {
  return {
    id,
    name: id.toUpperCase(),
    endpoint: `wss://${id}.example.test`,
    deviceToken: 'token',
    publicKeyB64: 'public-key',
    lastConnected: 1
  }
}

function mountCatalogs(initial: readonly DesktopClient[]) {
  let latest: MergedDesktopCatalogs | null = null
  function Probe({ desktops }: { desktops: readonly DesktopClient[] }) {
    latest = useMergedDesktopCatalogs(desktops)
    return null
  }
  let renderer!: ReactTestRenderer
  act(() => {
    renderer = create(createElement(Probe, { desktops: initial }))
  })
  return {
    get value(): MergedDesktopCatalogs {
      if (!latest) {
        throw new Error('probe did not render')
      }
      return latest
    },
    rebind(desktops: readonly DesktopClient[]) {
      act(() => renderer.update(createElement(Probe, { desktops })))
    },
    unmount() {
      act(() => renderer.unmount())
    }
  }
}

function takePending(client: TestClient, method: string): PendingRequest {
  const index = client.pending.findIndex((request) => request.method === method)
  if (index === -1) {
    throw new Error(`no pending ${method}`)
  }
  return client.pending.splice(index, 1)[0]!
}

async function settlePending(request: PendingRequest, response: RpcResponse): Promise<void> {
  await act(async () => {
    request.resolve(response)
    await Promise.resolve()
  })
}

async function settle(client: TestClient, method: string, response: RpcResponse): Promise<void> {
  await settlePending(takePending(client, method), response)
}

async function settleCatalog(
  client: TestClient,
  worktrees: Worktree[],
  repos: unknown[] = [{ id: 'repo-1', displayName: 'orca' }]
): Promise<void> {
  await settle(client, 'worktree.ps', success({ worktrees }))
  await settle(client, 'repo.list', success({ repos }))
}

describe('useMergedDesktopCatalogs', () => {
  it('fetches desktops beyond the three-client home budget one at a time and releases them', async () => {
    const clients = Array.from({ length: 5 }, () => makeClient())
    const active = new Set<string>()
    const acquired: string[] = []
    const released: string[] = []
    const acquireClient: NonNullable<DesktopClient['acquireClient']> = async (host) => {
      acquired.push(host.id)
      active.add(host.id)
      expect(active.size).toBe(1)
      const index = Number(host.id.slice(-1)) - 1
      return {
        client: clients[index]!.rpc,
        release: () => {
          active.delete(host.id)
          released.push(host.id)
        }
      }
    }
    const probe = mountCatalogs([
      desktop('host-1', clients[0]!, 'connected'),
      desktop('host-2', clients[1]!, 'connected'),
      desktop('host-3', clients[2]!, 'connected'),
      {
        hostId: 'host-4',
        hostName: 'HOST-4',
        client: null,
        state: 'disconnected',
        profile: profile('host-4'),
        acquireClient
      },
      {
        hostId: 'host-5',
        hostName: 'HOST-5',
        client: null,
        state: 'disconnected',
        profile: profile('host-5'),
        acquireClient
      }
    ])

    await act(async () => {
      clients
        .slice(0, 3)
        .forEach((client, index) =>
          takePending(client, 'worktree.ps').resolve(
            success({ worktrees: [row(`row-${index + 1}`)] })
          )
        )
      await Promise.resolve()
      clients
        .slice(0, 3)
        .forEach((client) => takePending(client, 'repo.list').resolve(success({ repos: [] })))
      await Promise.resolve()
    })
    expect(acquired).toEqual(['host-4'])
    expect(probe.value.rosterSettled).toBe(false)

    await settleCatalog(clients[3]!, [row('row-4')])
    await act(() => Promise.resolve())
    expect(acquired).toEqual(['host-4', 'host-5'])
    expect(released).toEqual(['host-4'])

    await settleCatalog(clients[4]!, [row('row-5')])
    expect(probe.value.catalogs.map((catalog) => catalog.desktopHostId)).toEqual([
      'host-1',
      'host-2',
      'host-3',
      'host-4',
      'host-5'
    ])
    expect(released).toEqual(['host-4', 'host-5'])
    expect(active.size).toBe(0)
    expect(probe.value.rosterSettled).toBe(true)
  })

  it('does not abort an on-demand refresh when its client is published', async () => {
    const client = makeClient()
    let signal: AbortSignal | undefined
    let resolveLease!: (lease: { client: RpcClient; release: () => void }) => void
    let markOwned!: (client: RpcClient) => void
    const acquireClient: NonNullable<DesktopClient['acquireClient']> = (
      _host,
      nextSignal,
      onClientOwned
    ) => {
      signal = nextSignal
      markOwned = onClientOwned ?? (() => {})
      return new Promise((resolve) => {
        resolveLease = resolve
      })
    }
    const onDemand: DesktopClient = {
      hostId: 'published-transient',
      hostName: 'Published transient',
      client: null,
      state: 'disconnected',
      profile: profile('published-transient'),
      acquireClient
    }
    const release = vi.fn()
    const probe = mountCatalogs([onDemand])
    await act(() => Promise.resolve())

    await act(async () => {
      markOwned(client.rpc)
      probe.rebind([{ ...onDemand, client: client.rpc, state: 'connected' }])
      resolveLease({ client: client.rpc, release })
      await Promise.resolve()
    })
    expect(signal?.aborted).toBe(false)
    expect(client.pending.map((request) => request.method)).toEqual(['worktree.ps'])
    await settleCatalog(client, [row('transient-result')])

    expect(probe.value.catalogs[0]?.worktrees[0]?.worktreeId).toBe('transient-result')
    expect(release).toHaveBeenCalledOnce()
    probe.unmount()
  })

  it('refreshes again when a persistent owner keeps the transient client', async () => {
    const client = makeClient()
    let resolveLease!: (lease: { client: RpcClient; release: () => void }) => void
    let markOwned!: (client: RpcClient) => void
    const acquireClient: NonNullable<DesktopClient['acquireClient']> = (
      _host,
      _signal,
      onClientOwned
    ) => {
      markOwned = onClientOwned ?? (() => {})
      return new Promise((resolve) => {
        resolveLease = resolve
      })
    }
    const onDemand: DesktopClient = {
      hostId: 'persistent-takeover',
      hostName: 'Persistent takeover',
      client: null,
      state: 'disconnected',
      profile: profile('persistent-takeover'),
      acquireClient
    }
    const probe = mountCatalogs([onDemand])
    await act(() => Promise.resolve())

    await act(async () => {
      markOwned(client.rpc)
      probe.rebind([{ ...onDemand, client: client.rpc, state: 'connected' }])
      resolveLease({ client: client.rpc, release: vi.fn() })
      await Promise.resolve()
    })
    await settleCatalog(client, [row('transient-pass')])
    await act(() => Promise.resolve())
    await settleCatalog(client, [row('persistent-pass')])

    expect(probe.value.catalogs[0]?.worktrees[0]?.worktreeId).toBe('persistent-pass')
  })

  it('retains a disconnected desktop while another desktop refreshes', async () => {
    const left = makeClient()
    const right = makeClient()
    const probe = mountCatalogs([
      desktop('left-retain', left, 'connected'),
      desktop('right-retain', right, 'connected')
    ])

    await settleCatalog(left, [row('left-old')])
    await settleCatalog(right, [row('right-old')])
    expect(probe.value.catalogs.flatMap((catalog) => catalog.worktrees)).toHaveLength(2)

    probe.rebind([
      desktop('left-retain', left, 'disconnected'),
      desktop('right-retain', right, 'connected')
    ])
    await settleCatalog(right, [row('right-new')])

    expect(probe.value.catalogs.map((catalog) => catalog.worktrees[0]?.worktreeId)).toEqual([
      'left-old',
      'right-new'
    ])
  })

  it('fences a late response from a replaced client with the same host id', async () => {
    const oldClient = makeClient()
    const newClient = makeClient()
    const probe = mountCatalogs([desktop('same-host-race', oldClient, 'connected')])

    probe.rebind([desktop('same-host-race', newClient, 'connected')])
    await settleCatalog(newClient, [row('new-client')])
    expect(probe.value.catalogs[0]?.worktrees[0]?.worktreeId).toBe('new-client')

    await settleCatalog(oldClient, [row('old-client')])
    expect(probe.value.catalogs[0]?.worktrees[0]?.worktreeId).toBe('new-client')
  })

  it('refreshes when the runtime reports a workspace snapshot change', async () => {
    const client = makeClient()
    const probe = mountCatalogs([desktop('snapshot-change', client, 'connected')])
    await settleCatalog(client, [row('before')])

    act(() => client.emit({ type: 'worktreesChanged' }))
    await settleCatalog(client, [row('after')])

    expect(probe.value.catalogs[0]?.worktrees[0]?.worktreeId).toBe('after')
  })

  it('accepts an earlier overlapping success when the newer request fails', async () => {
    const client = makeClient()
    const probe = mountCatalogs([desktop('overlap-fallback', client, 'connected')])
    const earlier = takePending(client, 'worktree.ps')

    act(() => client.emit({ type: 'worktreesChanged' }))
    await settlePending(earlier, success({ worktrees: [row('earlier-success')] }))
    const newer = takePending(client, 'worktree.ps')
    const earlierRepos = takePending(client, 'repo.list')
    await settlePending(newer, failure())
    await settlePending(earlierRepos, success({ repos: [] }))

    expect(probe.value.catalogs[0]?.worktrees[0]?.worktreeId).toBe('earlier-success')
  })

  it('keeps a newer overlapping success when the older request finishes last', async () => {
    const client = makeClient()
    const probe = mountCatalogs([desktop('overlap-newest', client, 'connected')])
    const earlier = takePending(client, 'worktree.ps')

    act(() => client.emit({ type: 'worktreesChanged' }))
    await settlePending(earlier, success({ worktrees: [row('older-success')] }))
    const newer = takePending(client, 'worktree.ps')
    const earlierRepos = takePending(client, 'repo.list')
    await settlePending(newer, success({ worktrees: [row('newer-success')] }))
    const newerRepos = takePending(client, 'repo.list')
    await settlePending(newerRepos, success({ repos: [] }))
    await settlePending(earlierRepos, success({ repos: [] }))

    expect(probe.value.catalogs[0]?.worktrees[0]?.worktreeId).toBe('newer-success')
  })

  it('accepts an initial response after the desktop is renamed', async () => {
    const client = makeClient()
    const probe = mountCatalogs([desktop('rename-fetch', client, 'connected', 'Before')])

    probe.rebind([desktop('rename-fetch', client, 'connected', 'After')])
    await settleCatalog(client, [row('renamed-host')])

    expect(probe.value.catalogs[0]).toMatchObject({
      desktopHostName: 'After',
      worktrees: [{ worktreeId: 'renamed-host' }]
    })
  })

  it('does not mutate cache after unmount', async () => {
    const client = makeClient()
    const probe = mountCatalogs([desktop('unmount-fence', client, 'connected')])
    const request = takePending(client, 'worktree.ps')
    probe.unmount()

    await settlePending(request, success({ worktrees: [row('too-late')] }))
    await settle(client, 'repo.list', success({ repos: [] }))

    expect(getProvenCachedWorktrees('unmount-fence')).toBeNull()
  })

  it('cancels and releases a transient lease that resolves after unmount', async () => {
    const client = makeClient()
    let resolveLease!: (lease: { client: RpcClient; release: () => void }) => void
    let signal: AbortSignal | undefined
    const release = vi.fn()
    const acquireClient: NonNullable<DesktopClient['acquireClient']> = (_host, nextSignal) => {
      signal = nextSignal
      return new Promise((resolve) => {
        resolveLease = resolve
      })
    }
    const probe = mountCatalogs([
      {
        hostId: 'transient-unmount',
        hostName: 'Transient',
        client: null,
        state: 'disconnected',
        profile: profile('transient-unmount'),
        acquireClient
      }
    ])
    await act(() => Promise.resolve())
    probe.unmount()

    await act(async () => {
      resolveLease({ client: client.rpc, release })
      await Promise.resolve()
    })

    expect(signal?.aborted).toBe(true)
    expect(release).toHaveBeenCalledOnce()
  })

  it('preserves proven rows and repo metadata across malformed and failed refreshes', async () => {
    const client = makeClient()
    const probe = mountCatalogs([desktop('invalid-refresh', client, 'connected')])
    await settleCatalog(
      client,
      [row('before')],
      [{ id: 'repo-1', displayName: 'orca', connectionId: 'gpu-box' }]
    )

    act(() => client.emit({ type: 'worktreesChanged' }))
    await settle(client, 'worktree.ps', success({ nope: [] }))
    expect(probe.value.catalogs[0]?.worktrees[0]?.worktreeId).toBe('before')

    act(() => client.emit({ type: 'worktreesChanged' }))
    await settle(
      client,
      'worktree.ps',
      success({ worktrees: [{ ...row('bad-agents'), agents: [{ paneKey: 7 }] }] })
    )
    expect(probe.value.catalogs[0]?.worktrees[0]?.worktreeId).toBe('before')

    act(() => client.emit({ type: 'worktreesChanged' }))
    await settle(
      client,
      'worktree.ps',
      success({
        worktrees: [{ ...row('bad-linked-pr'), linkedPR: { number: '7', state: 'open' } }]
      })
    )
    expect(probe.value.catalogs[0]?.worktrees[0]?.worktreeId).toBe('before')

    act(() => client.emit({ type: 'worktreesChanged' }))
    await settle(client, 'worktree.ps', failure())
    expect(probe.value.catalogs[0]?.worktrees[0]?.worktreeId).toBe('before')

    act(() => client.emit({ type: 'worktreesChanged' }))
    await settle(client, 'worktree.ps', success({ worktrees: [row('after')] }))
    await settle(client, 'repo.list', success({ nope: [] }))
    expect(probe.value.catalogs[0]).toMatchObject({
      worktrees: [{ worktreeId: 'after' }],
      repos: [{ connectionId: 'gpu-box' }]
    })

    act(() => client.emit({ type: 'reposChanged' }))
    await settle(client, 'worktree.ps', success({ worktrees: [row('unsafe-decoration')] }))
    await settle(
      client,
      'repo.list',
      success({
        repos: [
          {
            id: 'repo-1',
            displayName: 'orca',
            badgeColor: 'url(javascript:alert(1))',
            repoIcon: { type: 'image', source: 'favicon', src: 'http://example.test/icon.png' }
          }
        ]
      })
    )
    expect(probe.value.catalogs[0]).toMatchObject({
      worktrees: [{ worktreeId: 'unsafe-decoration' }],
      repos: [{ connectionId: 'gpu-box' }]
    })
  })
})
