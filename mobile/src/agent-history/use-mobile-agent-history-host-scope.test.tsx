import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import type { Worktree } from '../worktree/workspace-list-types'

const connection = vi.hoisted((): { client: RpcClient | null; state: ConnectionState } => ({
  client: null,
  state: 'connected'
}))
vi.mock('../transport/client-context', () => ({
  useHostClient: () => connection,
  useForceReconnect: () => vi.fn()
}))
import { useMobileAgentHistoryState } from './use-mobile-agent-history-state'

function fakeClient(sendRequest: RpcClient['sendRequest']): RpcClient {
  return {
    sendRequest,
    subscribe: () => () => {},
    updateTerminalSubscriptionViewport: () => {},
    getState: () => connection.state,
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {},
    getGeneration: () => 1
  }
}

const sshWorktree: Worktree = {
  worktreeId: 'ssh-wt',
  repoId: 'ssh-repo',
  repo: 'app',
  branch: 'main',
  displayName: 'ssh-wt',
  path: '/home/ada/app',
  hostId: 'ssh:builder',
  liveTerminalCount: 0,
  hasAttachedPty: false,
  preview: '',
  unread: false,
  isPinned: false,
  linkedPR: null
}

const WORKTREES = [sshWorktree]

async function scanCalls(
  capabilities: string[],
  scanReply: (params: unknown) => { ok: boolean; result?: unknown; error?: unknown }
): Promise<unknown[]> {
  const scans: unknown[] = []
  const send = vi.fn<RpcClient['sendRequest']>(async (method, params) => {
    if (method === 'status.get') {
      return { id: 's', ok: true, result: { hostPlatform: 'linux', capabilities } }
    }
    scans.push(params)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test reply shape is validated by the reader under test.
    return { id: 'r', ...scanReply(params) } as Awaited<ReturnType<RpcClient['sendRequest']>>
  })
  connection.client = fakeClient(send)
  connection.state = 'connected'
  function Probe() {
    useMobileAgentHistoryState({
      hostId: 'host',
      worktreeId: 'ssh-wt',
      worktrees: WORKTREES,
      worktreesLoaded: true
    })
    return null
  }
  await act(async () => {
    create(createElement(Probe))
  })
  return scans
}

const OK = { ok: true, result: { sessions: [], issues: [] } }

it('requests the SSH worktree host scope when the host advertises it', async () => {
  const scans = await scanCalls(['aiVault.v1', 'aiVault.host-scope.v1'], () => OK)
  expect(scans[0]).toMatchObject({ executionHostScope: 'ssh:builder' })
})

it('sends no scope to a host that does not advertise it', async () => {
  const scans = await scanCalls(['aiVault.v1'], () => OK)
  expect(scans).toHaveLength(1)
  expect(scans[0]).not.toHaveProperty('executionHostScope')
})

it('falls back to the unscoped scan when the SSH scope is refused', async () => {
  const scans = await scanCalls(['aiVault.v1', 'aiVault.host-scope.v1'], (params) =>
    params && typeof params === 'object' && 'executionHostScope' in params
      ? { ok: false, error: { code: 'runtime_error', message: 'not connected' } }
      : OK
  )
  expect(scans).toHaveLength(2)
  expect(scans[1]).not.toHaveProperty('executionHostScope')
})
