import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY } from '../../../src/shared/mobile-desktop-relay-contract'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import { createStableLogicalRpcClient } from '../transport/stable-logical-rpc-client'
import { getWorktreeRowIdentity } from '../worktree/worktree-host-row-identity'
import { conversationHistory, conversationWorkspace } from './project-conversations.test-fixture'
import {
  useProjectConversations,
  type ProjectConversationsSource
} from './use-project-conversations'

const trees: ReactTestRenderer[] = []
afterEach(() => {
  act(() => trees.forEach((tree) => tree.unmount()))
  trees.length = 0
  vi.useRealTimers()
})

function source(client: RpcClient): ProjectConversationsSource {
  return {
    client,
    hostId: 'paired-host',
    connState: 'connected',
    displayWorktrees: [conversationWorkspace()],
    hostCapabilities: [],
    state: { serverWorkspaces: { hosts: [], worktrees: [] }, repoHostIdByRepoId: new Map() },
    catalog: { onRefresh: async () => {} }
  }
}

function replies() {
  const sendRequest = vi.fn<RpcClient['sendRequest']>(async (method) => ({
    id: 'one',
    ok: true,
    result:
      method === 'status.get'
        ? { capabilities: ['aiVault.v1'] }
        : method === 'aiVault.listSessions'
          ? { sessions: [conversationHistory()], issues: [], includesStructuredSessions: true }
          : {
              tabs: [
                {
                  type: 'agent-session',
                  id: 'empty-tab',
                  sessionId: 'empty-chat',
                  agent: 'codex',
                  title: 'An empty open chat'
                }
              ]
            }
  }))
  return { client: { ...new FakeSession('connected'), sendRequest }, sendRequest }
}

async function mount(initial: ProjectConversationsSource) {
  let props = initial
  const observed: { current: ReturnType<typeof useProjectConversations> | null } = { current: null }
  function Probe() {
    observed.current = useProjectConversations(props)
    return null
  }
  let tree: ReactTestRenderer | undefined
  await act(async () => {
    tree = create(createElement(Probe))
    trees.push(tree)
  })
  return {
    read: () => {
      if (!observed.current) {
        throw new Error('missing hook')
      }
      return observed.current
    },
    unmount: () => act(() => tree?.unmount()),
    update: async (next: ProjectConversationsSource) => {
      props = next
      await act(async () => tree?.update(createElement(Probe)))
    }
  }
}

describe('host-owned conversation snapshots', () => {
  it('shows the warm list immediately on return and refreshes stale rows in the background', async () => {
    vi.useFakeTimers()
    const { client, sendRequest } = replies()
    const initial = { ...source(client), hostCapabilities: ['known-host-capability'] }
    const first = await mount(initial)
    first.unmount()
    const calls = sendRequest.mock.calls.length
    const warm = await mount({ ...initial, hostCapabilities: [] })
    expect(warm.read().loading).toBe(false)
    expect(warm.read().history).toHaveLength(1)
    expect(sendRequest).toHaveBeenCalledTimes(calls)
    warm.unmount()
    await vi.advanceTimersByTimeAsync(15_000)
    let settle: (reply: RpcResponse) => void = () => {}
    sendRequest.mockImplementation((method) =>
      method === 'aiVault.listSessions'
        ? new Promise((resolve) => {
            settle = resolve
          })
        : Promise.resolve({
            id: 'next',
            ok: true,
            result: method === 'status.get' ? { capabilities: ['aiVault.v1'] } : { tabs: [] }
          })
    )
    const returned = await mount(initial)
    expect(returned.read().loading).toBe(false)
    expect(returned.read().history).toHaveLength(1)
    await act(async () =>
      settle({
        id: 'fresh',
        ok: true,
        result: { sessions: [], issues: [], includesStructuredSessions: true }
      })
    )
    expect(returned.read().history).toEqual([])
    expect(returned.read().tabs.get(getWorktreeRowIdentity(conversationWorkspace()))).toEqual([])
  })

  it('does not restore a cached list after a host or generation change while unmounted', async () => {
    const original = replies()
    const client = createStableLogicalRpcClient(original.client, 'lan')
    const first = await mount(source(client))
    first.unmount()
    const replacement = replies()
    replacement.sendRequest.mockImplementation(() => new Promise(() => {}))
    await client.migrateTo(replacement.client, 'relay')
    const returned = await mount(source(client))
    expect(returned.read().loading).toBe(true)
    expect(returned.read().history).toEqual([])
    returned.unmount()
    const other = await mount({ ...source(original.client), hostId: 'another-host' })
    other.unmount()
    original.sendRequest.mockImplementation(() => new Promise(() => {}))
    const changed = await mount(source(original.client))
    expect(changed.read().history).toEqual([])
    expect(changed.read().loading).toBe(true)
  })

  it('invalidates connected cutover snapshots immediately and continues polling the new authority', async () => {
    vi.useFakeTimers()
    const original = replies()
    const client = createStableLogicalRpcClient(original.client, 'lan')
    const probe = await mount({ ...source(client), hostCapabilities: ['old-authority'] })
    expect(probe.read().complete).toBe(true)
    expect(probe.read().history).toHaveLength(1)
    expect(probe.read().tabs.size).toBe(1)

    const replacement = replies()
    let settle: (reply: RpcResponse) => void = () => {}
    replacement.sendRequest.mockImplementation((method) =>
      method === 'status.get'
        ? new Promise((resolve) => {
            settle = resolve
          })
        : Promise.reject(new Error('new authority temporarily unavailable'))
    )
    await act(async () => {
      await client.migrateTo(replacement.client, 'relay')
    })
    expect(client.getState()).toBe('connected')
    expect(probe.read().loading).toBe(true)
    expect(probe.read().complete).toBe(false)
    expect(probe.read().history).toEqual([])
    expect(probe.read().tabs.size).toBe(0)
    expect(probe.read().capabilitiesFor('local')).toEqual([])
    await act(async () => {
      settle({
        id: 'unavailable',
        ok: false,
        error: { code: 'unavailable', message: 'temporarily offline' }
      })
    })
    expect(probe.read().failed).toBe(true)
    expect(probe.read().history).toEqual([])
    expect(probe.read().capabilitiesFor('local')).toEqual([])

    replacement.sendRequest.mockImplementation(async (method) => ({
      id: 'replacement',
      ok: true,
      result:
        method === 'status.get'
          ? { capabilities: ['aiVault.v1', 'new-authority'] }
          : method === 'aiVault.listSessions'
            ? { sessions: [], issues: [], includesStructuredSessions: true }
            : { tabs: [] }
    }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(probe.read().complete).toBe(true)
    expect(probe.read().failed).toBe(false)
    expect(probe.read().history).toEqual([])
    expect(probe.read().tabs.get(getWorktreeRowIdentity(conversationWorkspace()))).toEqual([])
    expect(probe.read().capabilitiesFor('local')).toContain('new-authority')
    expect(
      replacement.sendRequest.mock.calls.filter(([method]) => method === 'aiVault.listSessions')
    ).toHaveLength(2)
    expect(
      replacement.sendRequest.mock.calls.filter(([method]) => method === 'session.tabs.list')
    ).toHaveLength(3)
  })

  it('rejects a prior generation scan that settles after its replacement', async () => {
    const original = replies()
    let settle: (reply: RpcResponse) => void = () => {}
    original.sendRequest.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve
        })
    )
    const client = createStableLogicalRpcClient(original.client, 'lan')
    const probe = await mount({ ...source(client), displayWorktrees: [] })
    const replacement = replies()
    await act(async () => {
      await client.migrateTo(replacement.client, 'relay')
    })
    expect(probe.read().complete).toBe(true)
    expect(probe.read().history).toHaveLength(1)
    await act(async () => {
      settle({ id: 'old', ok: true, result: { capabilities: [] } })
    })
    expect(probe.read().complete).toBe(true)
    expect(probe.read().capabilitiesFor('local')).toEqual(['aiVault.v1'])
  })

  it('loads open empty chats and history without depending on worktree activity', async () => {
    const { client, sendRequest } = replies()
    const probe = await mount(source(client))
    expect(probe.read().complete).toBe(true)
    expect(
      probe.read().tabs.get(getWorktreeRowIdentity(conversationWorkspace()))?.[0]?.sessionId
    ).toBe('empty-chat')
    expect(sendRequest).toHaveBeenCalledWith('aiVault.listSessions', {
      unlimited: true,
      includeAntigravityIdeSessions: true,
      includeStructuredSessions: true,
      force: false
    })
  })

  it('keeps old snapshots on read failure and never borrows them across paired hosts', async () => {
    const { client, sendRequest } = replies()
    const original = source(client)
    const probe = await mount(original)
    sendRequest.mockRejectedValue(new Error('temporarily offline'))
    await act(async () => {
      probe.read().onRefresh()
    })
    expect(probe.read().failed).toBe(true)
    expect(probe.read().history).toHaveLength(1)
    expect(probe.read().tabs.size).toBe(1)
    expect(probe.read().capabilitiesFor('local')).toEqual(['aiVault.v1'])
    const replacement = replies()
    let settle: (reply: RpcResponse) => void = () => {}
    replacement.sendRequest.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve
        })
    )
    await probe.update({
      ...source(replacement.client),
      hostId: 'other-paired-host',
      displayWorktrees: []
    })
    expect(probe.read().history).toEqual([])
    expect(probe.read().tabs.size).toBe(0)
    await act(async () => {
      settle({ id: 'late', ok: true, result: { capabilities: [] } })
    })
  })

  it('uses scoped envelopes for a reachable server and refuses any local fallback without relay support', async () => {
    const { client, sendRequest } = replies()
    const original = source(client)
    const remote = conversationWorkspace({ hostId: 'runtime:server' })
    const remoteSource: ProjectConversationsSource = {
      ...original,
      displayWorktrees: [remote],
      hostCapabilities: [MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY],
      state: {
        ...original.state,
        serverWorkspaces: {
          hosts: [
            { hostId: 'runtime:server', label: 'Build server', relay: 'ready', health: 'available' }
          ],
          worktrees: [remote]
        }
      }
    }
    const probe = await mount(remoteSource)
    expect(sendRequest).toHaveBeenCalledWith(
      'session.tabs.list',
      { worktree: `id:${remote.worktreeId}` },
      { envelope: { executionHost: 'runtime:server' } }
    )
    expect(probe.read().history.some((row) => row.executionHostId === 'runtime:server')).toBe(true)
    sendRequest.mockClear()
    await probe.update({ ...remoteSource, hostCapabilities: [] })
    expect(sendRequest.mock.calls.some(([method]) => method === 'session.tabs.list')).toBe(false)
    expect(probe.read().capabilitiesFor('runtime:server')).toEqual([])
  })
})

it('marks successful partial history replies incomplete while keeping their readable rows', async () => {
  const { client, sendRequest } = replies()
  sendRequest.mockImplementation(async (method) => ({
    id: 'partial',
    ok: true,
    result:
      method === 'status.get'
        ? { capabilities: ['aiVault.v1'] }
        : method === 'aiVault.listSessions'
          ? {
              sessions: [conversationHistory()],
              issues: [{ message: 'One provider could not be scanned' }],
              includesStructuredSessions: true
            }
          : { tabs: [] }
  }))
  const probe = await mount(source(client))
  expect(probe.read().history).toHaveLength(1)
  expect(probe.read().complete).toBe(false)
  expect(probe.read().failed).toBe(true)
})

it('reuses per-host history fingerprints on automatic refresh while manual refresh requests a full snapshot', async () => {
  vi.useFakeTimers()
  const fingerprint = 'a'.repeat(64)
  const { client, sendRequest } = replies()
  sendRequest.mockImplementation(async (method, params) => {
    const query = params !== null && typeof params === 'object' ? params : {}
    return {
      id: 'conditional',
      ok: true,
      result:
        method === 'status.get'
          ? { capabilities: ['aiVault.v1'] }
          : method === 'aiVault.listSessions'
            ? 'afterFingerprint' in query && query.afterFingerprint === fingerprint
              ? {
                  sessions: [],
                  issues: [],
                  unchanged: true,
                  fingerprint,
                  includesStructuredSessions: true
                }
              : {
                  sessions: 'force' in query && query.force ? [] : [conversationHistory()],
                  issues: [],
                  fingerprint,
                  includesStructuredSessions: true
                }
            : { tabs: [] }
    }
  })
  const probe = await mount(source(client))
  expect(probe.read().history).toHaveLength(1)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000)
  })
  const requests = () =>
    sendRequest.mock.calls.filter(([method]) => method === 'aiVault.listSessions')
  expect(requests().at(-1)?.[1]).toHaveProperty('afterFingerprint', fingerprint)
  expect(probe.read().history).toHaveLength(1)
  await act(async () => {
    probe.read().onRefresh()
  })
  expect(requests().at(-1)?.[1]).not.toHaveProperty('afterFingerprint')
  expect(requests().at(-1)?.[1]).toHaveProperty('force', true)
  expect(probe.read().history).toEqual([])
})
