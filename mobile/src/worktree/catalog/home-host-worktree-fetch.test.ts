import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BOTS_MOBILE_RUNTIME_CAPABILITY } from '../../../../src/shared/bot-runtime-capabilities'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { ConnectionState } from '../../transport/connection/connection-state'
import type { RpcResponse } from '../../transport/rpc/rpc-wire-types'
import {
  selectActiveAgents,
  selectAgentsNeedingYou,
  type AgentListInput
} from '../../agents/agent-list-rows'
import { homeWorktreeCountsQuery } from './home-host-worktree-fetch'
import { homeWorktreeInfo } from './home-worktree-info'

vi.mock('react-native', () => ({}))

type FakeSession = {
  client: RpcClient
  calls: number
  settle: (response: RpcResponse | Error) => void
}

// Answers status.get at once, so `calls` and `settle` see only the catalog reads (and bot lists for `capabilities`).
function fakeSession(capabilities: string[] = []): FakeSession {
  const pending: ((response: RpcResponse | Error) => void)[] = []
  const fake: FakeSession = {
    calls: 0,
    settle(response: RpcResponse | Error) {
      const next = pending.shift()
      next?.(response)
    },
    client: {
      sendRequest: (method: string) => {
        if (method === 'status.get') {
          const status: RpcResponse = { id: 'status', ok: true, result: { capabilities } }
          return Promise.resolve(status)
        }
        fake.calls += 1
        return new Promise<RpcResponse>((resolve, reject) => {
          pending.push((response) =>
            response instanceof Error ? reject(response) : resolve(response)
          )
        })
      },
      subscribe: () => () => {},
      updateTerminalSubscriptionViewport: () => {},
      getState: (): ConnectionState => 'connected',
      getReconnectAttempt: () => 0,
      getLastConnectedAt: () => null,
      onStateChange: () => () => {},
      notifyForeground: () => {},
      close: () => {
        for (const settle of pending.splice(0)) {
          settle(new Error('Client closed'))
        }
      }
    }
  }
  return fake
}

// Drains the promise chain so a retry queued in a .catch has reached the transport.
const flush = () => vi.advanceTimersByTimeAsync(0)

function readCounts(client: RpcClient) {
  return homeWorktreeCountsQuery.fetch(client, { exec: 'local' }, {}, undefined, {
    live: false,
    previousFromStore: false,
    hostId: 'host-1'
  })
}

describe('homeWorktreeCountsQuery', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(1_700_000_000_000)
  })
  afterEach(() => {
    vi.useRealTimers()
  })
  it('leaves bot homes out of the counts on a host that lists its bots', async () => {
    const host = fakeSession([BOTS_MOBILE_RUNTIME_CAPABILITY])
    const row = { repo: 'Bots', branch: '', displayName: 'Atlas', liveTerminalCount: 0 }
    const worktrees = [
      { ...row, worktreeId: 'folder:atlas-home', status: 'working' },
      { ...row, worktreeId: 'wt-1', status: 'working' },
      { ...row, worktreeId: 'wt-2', status: 'inactive' }
    ]

    const loaded = readCounts(host.client)
    const catalog: RpcResponse = { id: 'catalog', ok: true, result: { worktrees } }
    const botList: RpcResponse = {
      id: 'bots',
      ok: true,
      result: {
        bots: [
          {
            id: 'atlas',
            name: 'Atlas',
            folderWorkspaceId: 'atlas-home',
            avatar: null,
            paused: false,
            agent: 'claude',
            notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
            members: [],
            slack: null,
            linear: null,
            github: null,
            chatSessionId: null
          }
        ],
        botsEnabled: true,
        hideBotCreatedWorkspaces: false
      }
    }
    host.settle(catalog)
    // The bot list follows the status answer, after the catalog read went out.
    await flush()
    host.settle(botList)

    await expect(loaded).resolves.toMatchObject({ totalWorktrees: 2, activeCount: 1 })
  })

  it('keeps a bot chat waiting on the user in Active and the badge, once, beside its workers', async () => {
    const host = fakeSession([BOTS_MOBILE_RUNTIME_CAPABILITY])
    const now = 1_700_000_000_000
    const agent = (paneKey: string, status: 'permission' | 'idle', childOf?: string) => ({
      paneKey,
      parentPaneKey: childOf ?? null,
      state: 'idle',
      agentType: 'claude',
      prompt: '',
      stateStartedAt: now,
      updatedAt: now,
      activity: {
        listed: true,
        status,
        unread: false,
        clearable: false,
        sortAt: now,
        title: paneKey,
        ...(childOf ? { childOf } : {})
      }
    })
    const row = { repo: 'Bots', branch: '', liveTerminalCount: 1 }
    const worktrees = [
      {
        ...row,
        worktreeId: 'folder:atlas-home',
        displayName: 'atlas-home',
        agents: [agent('atlas-asks', 'permission'), agent('atlas-quiet', 'idle')]
      },
      {
        ...row,
        worktreeId: 'wt-1',
        displayName: 'Fix login',
        agents: [agent('atlas-worker', 'permission', 'atlas-asks')]
      }
    ]
    const loaded = readCounts(host.client)
    host.settle({ id: 'catalog', ok: true, result: { worktrees } })
    await flush()
    host.settle({
      id: 'bots',
      ok: true,
      result: {
        bots: [
          {
            id: 'atlas',
            name: 'Atlas',
            folderWorkspaceId: 'atlas-home',
            avatar: 'mascot:owl',
            paused: false,
            agent: 'claude',
            notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
            members: [],
            slack: null,
            linear: null,
            github: null,
            chatSessionId: null
          }
        ],
        botsEnabled: true,
        hideBotCreatedWorkspaces: false
      }
    })
    const counts = await loaded
    const info = homeWorktreeInfo(
      'host-1',
      { data: counts, dataUpdatedAt: now, failed: false },
      () => true
    )
    const input: AgentListInput = {
      hosts: [{ id: 'host-1' }],
      hostStates: { 'host-1': 'connected' },
      worktreeInfo: info ? { 'host-1': info } : {},
      now
    }

    expect(counts.totalWorktrees).toBe(1)
    const needsYou = selectAgentsNeedingYou(input)
    expect(
      needsYou.map((r) => [r.entry.agent.paneKey, r.entry.workspaceName, r.entry.bot])
    ).toEqual([
      ['atlas-asks', 'Atlas', { name: 'Atlas', avatar: 'mascot:owl' }],
      ['atlas-worker', 'Fix login', undefined]
    ])
    expect(selectActiveAgents(input).map((r) => r.entry.agent.paneKey)).toEqual([
      'atlas-asks',
      'atlas-worker'
    ])
  })

  it('counts bot homes as before on a host too old to list its bots', async () => {
    const host = fakeSession()
    const worktrees = [
      { repo: 'Bots', branch: '', displayName: 'Atlas', worktreeId: 'folder:atlas-home' }
    ]

    const catalog: RpcResponse = { id: 'catalog', ok: true, result: { worktrees } }
    const loaded = readCounts(host.client)
    host.settle(catalog)

    await expect(loaded).resolves.toMatchObject({ totalWorktrees: 1 })
  })
})
