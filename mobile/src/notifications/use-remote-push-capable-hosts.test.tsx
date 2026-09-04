import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadHostCatalog } from '../transport/host-store'
import type { HostCatalogEntry } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import { startRuntimeCapabilityProbe } from '../transport/runtime-capability-probe'
import { useAllHostClients } from '../transport/use-all-host-clients'
import {
  useRemotePushCapableHosts,
  type RemotePushHostSupport
} from './use-remote-push-capable-hosts'

vi.mock('../transport/host-store', () => ({ loadHostCatalog: vi.fn() }))
vi.mock('../transport/use-all-host-clients', () => ({ useAllHostClients: vi.fn() }))
vi.mock('../transport/runtime-capability-probe', () => ({
  startRuntimeCapabilityProbe: vi.fn()
}))

// The real module reaches expo-notifications and the preference store for the token
// path; only the capability string matters here.
vi.mock('./push-registration', () => ({
  NOTIFICATIONS_REMOTE_PUSH_CAPABILITY: 'notifications.remote-push.v1'
}))

const CAPABILITY = 'notifications.remote-push.v1'

type ClientEntry = { hostId: string; client: RpcClient; state: string }

/** Distinct object per host, so identity changes are the thing under test. */
function clientFor(hostId: string): RpcClient {
  return { hostId } as unknown as RpcClient
}

let renderer: ReactTestRenderer | null = null
let latest: RemotePushHostSupport = { supported: false, resolved: false }
const answerByHostId = new Map<string, (capabilities: readonly string[]) => void>()
const stopProbe = vi.fn()

function Harness(): null {
  latest = useRemotePushCapableHosts()
  return null
}

async function mount(): Promise<void> {
  await act(async () => {
    renderer = create(createElement(Harness))
    await Promise.resolve()
  })
}

async function setClients(entries: readonly ClientEntry[]): Promise<void> {
  vi.mocked(useAllHostClients).mockReturnValue(entries as never)
  await act(async () => {
    renderer?.update(createElement(Harness))
    await Promise.resolve()
  })
}

async function answer(hostId: string, capabilities: readonly string[]): Promise<void> {
  await act(async () => {
    answerByHostId.get(hostId)?.(capabilities)
    await Promise.resolve()
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  answerByHostId.clear()
  latest = { supported: false, resolved: false }
  vi.mocked(useAllHostClients).mockReturnValue([] as never)
  vi.mocked(startRuntimeCapabilityProbe).mockImplementation((client, onCapabilities) => {
    answerByHostId.set((client as unknown as { hostId: string }).hostId, onCapabilities)
    return stopProbe
  })
  vi.mocked(loadHostCatalog).mockResolvedValue([
    { id: 'host-1', publicKeyB64: 'k1' },
    { id: 'host-2', publicKeyB64: 'k2' }
  ] as unknown as HostCatalogEntry[])
})

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})

describe('useRemotePushCapableHosts', () => {
  it('stays unresolved when the host catalog cannot be read', async () => {
    vi.mocked(loadHostCatalog).mockRejectedValue(new Error('keychain locked'))

    await mount()

    // Resolving here would render "Update your desktop app" at someone whose desktop
    // is already current, on the strength of a catalog read that simply failed.
    expect(latest).toEqual({ supported: false, resolved: false })
  })

  it('waits for every connected host before answering', async () => {
    await mount()
    await setClients([
      { hostId: 'host-1', client: clientFor('host-1'), state: 'connected' },
      { hostId: 'host-2', client: clientFor('host-2'), state: 'connected' }
    ])

    await answer('host-1', [CAPABILITY])
    expect(latest.resolved).toBe(false)

    await answer('host-2', ['some-other.v1'])
    expect(latest).toEqual({ supported: true, resolved: true })
  })

  it('keeps the answer of a host that has since disconnected', async () => {
    await mount()
    const client = clientFor('host-1')
    await setClients([{ hostId: 'host-1', client, state: 'connected' }])
    await answer('host-1', [CAPABILITY])

    await setClients([{ hostId: 'host-1', client, state: 'connecting' }])

    expect(latest).toEqual({ supported: true, resolved: true })
  })

  it('resolves immediately when nothing is paired', async () => {
    vi.mocked(loadHostCatalog).mockResolvedValue([])

    await mount()

    expect(latest).toEqual({ supported: false, resolved: true })
  })

  it('leaves a running probe alone when another host changes state', async () => {
    await mount()
    const first = clientFor('host-1')
    await setClients([{ hostId: 'host-1', client: first, state: 'connected' }])
    expect(startRuntimeCapabilityProbe).toHaveBeenCalledTimes(1)

    // useAllHostClients rebuilds its array on every connection tick, so a plain
    // dependency on it would tear down and restart host-1's probe here.
    await setClients([
      { hostId: 'host-1', client: first, state: 'connected' },
      { hostId: 'host-2', client: clientFor('host-2'), state: 'connecting' }
    ])
    await setClients([
      { hostId: 'host-1', client: first, state: 'connected' },
      { hostId: 'host-2', client: clientFor('host-2'), state: 'connected' }
    ])

    expect(stopProbe).not.toHaveBeenCalled()
    expect(
      vi.mocked(startRuntimeCapabilityProbe).mock.calls.map(([client]) => client)
    ).toHaveLength(2)
  })

  it('restarts the probe when a reconnect replaces the host client', async () => {
    await mount()
    await setClients([{ hostId: 'host-1', client: clientFor('host-1'), state: 'connected' }])

    await setClients([{ hostId: 'host-1', client: clientFor('host-1'), state: 'connected' }])

    expect(stopProbe).toHaveBeenCalledTimes(1)
    expect(startRuntimeCapabilityProbe).toHaveBeenCalledTimes(2)
  })

  it('ignores an answer from a host the catalog no longer lists', async () => {
    await mount()
    await setClients([
      { hostId: 'host-ghost', client: clientFor('host-ghost'), state: 'connected' }
    ])

    await answer('host-ghost', [CAPABILITY])

    // An unpaired desktop cannot push to this phone, so its vote must not offer
    // the switch — nor count as the answer that resolves the section.
    expect(latest).toEqual({ supported: false, resolved: false })
  })
})
