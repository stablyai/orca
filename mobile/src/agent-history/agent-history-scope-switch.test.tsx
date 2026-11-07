// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { stubRpcClient } from '../transport/rpc-client-test-stub'
import type { ConnectionState, RpcResponse } from '../transport/types'
import type { Worktree } from '../worktree/workspace-list-types'
import { useMobileAgentHistoryState } from './use-mobile-agent-history-state'

const connection = vi.hoisted((): { client: RpcClient | null; state: ConnectionState } => ({
  client: null,
  state: 'connected'
}))
vi.mock('../transport/use-workspace-client', () => ({ useWorkspaceClient: () => connection }))
vi.mock('../transport/host-client-hooks', () => ({ useForceReconnect: () => null }))

const worktrees: Worktree[] = [
  {
    worktreeId: 'workspace',
    repoId: 'repo',
    repo: 'repo',
    branch: 'main',
    displayName: 'example',
    path: '/repo/app',
    liveTerminalCount: 0,
    hasAttachedPty: false,
    unread: false,
    isPinned: false,
    linkedPR: null
  }
]

function row(id: string, cwd: string) {
  return {
    id,
    agent: 'claude',
    sessionId: id,
    title: id,
    executionHostId: 'local',
    filePath: `/sessions/${id}.jsonl`,
    resumeCommand: `claude --resume ${id}`,
    cwd,
    modifiedAt: '',
    previewMessages: [],
    messageCount: 1
  }
}

it('does not show Workspace-only rows as All while All loads or the host is offline', async () => {
  const pending: ((reply: RpcResponse) => void)[] = []
  const send = vi.fn<RpcClient['sendRequest']>(async (method, params) => {
    if (method === 'status.get') {
      return { id: 'status', ok: true, result: { capabilities: ['aiVault.v1'] } }
    }
    const scopeOnly = typeof params === 'object' && params !== null && 'scopeOnly' in params
    return scopeOnly
      ? { id: 'scan', ok: true, result: { issues: [], sessions: [row('mine', '/repo/app')] } }
      : new Promise((resolve) => pending.push(resolve))
  })
  connection.client = stubRpcClient({ sendRequest: send, getState: () => connection.state })
  let current: ReturnType<typeof useMobileAgentHistoryState> | null = null
  function Probe() {
    current = useMobileAgentHistoryState({
      hostId: 'phone-host',
      worktreeId: 'workspace',
      worktrees,
      worktreesLoaded: true
    })
    return null
  }
  const read = () => {
    if (!current) {
      throw new Error('not mounted')
    }
    return current
  }
  const root = createRoot(document.createElement('div'))
  await act(async () => root.render(createElement(Probe)))
  try {
    expect(read().screenState).toMatchObject({ kind: 'ready', sessions: [{ id: 'mine' }] })

    await act(async () => read().onSelectScope('all'))
    expect(read().screenState).toEqual({ kind: 'loading' })

    const sessions = [row('mine', '/repo/app'), row('other', '/elsewhere')]
    await act(async () =>
      pending.shift()?.({ id: 'scan', ok: true, result: { issues: [], sessions } })
    )
    expect(read().screenState).toMatchObject({
      kind: 'ready',
      sessions: [{ id: 'mine' }, { id: 'other' }]
    })

    // Offline, Project's rows still cover Workspace, but All gets the offline state, not a spinner.
    await act(async () => read().onSelectScope('project'))
    connection.state = 'disconnected'
    await act(async () => read().onSelectScope('workspace'))
    expect(read().screenState.kind).toBe('ready')
    await act(async () => read().onSelectScope('all'))
    expect(read().screenState.kind).toBe('error')
  } finally {
    await act(async () => root.unmount())
  }
})
