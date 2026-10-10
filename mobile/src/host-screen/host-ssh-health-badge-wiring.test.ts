import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../cache/worktree-cache', () => ({
  getCachedWorktrees: () => null,
  setCachedWorktrees: () => {}
}))
vi.mock('../cache/repo-cache', () => ({ setCachedRepos: () => {} }))

import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import type { RpcResponse } from '../transport/types'
import type { Worktree } from '../worktree/workspace-list-types'
import { useHostDisplayWorktrees } from './use-host-display-worktrees'
import { useHostRepoMetadata } from './use-host-repo-metadata'
import { useHostScreenState } from './use-host-screen-state'

function reply(result: unknown): RpcResponse {
  return { id: 'reply', ok: true, result, _meta: { runtimeId: 'runtime' } }
}

function row(worktreeId: string, repoId: string): Worktree {
  return {
    workspaceKind: 'git',
    worktreeId,
    repoId,
    repo: repoId,
    branch: 'main',
    displayName: worktreeId,
    path: `/home/me/${worktreeId}`,
    liveTerminalCount: 0,
    hasAttachedPty: false,
    preview: '',
    unread: false,
    isPinned: false,
    linkedPR: null
  }
}

// Drives the screen's own state, metadata refresh and row projection against one desktop reply set.
async function displayedRows(args: {
  repos: { id: string; displayName: string; connectionId?: string }[]
  rows: Worktree[]
  sshTarget: Record<string, unknown>
  /** The catalog a second refresh answers, once the first has applied. */
  thenRepos?: { id: string; displayName: string; connectionId?: string }[]
}): Promise<Worktree[]> {
  let repos = args.repos
  const client = new FakeSession('connected')
  client.sendRequest.mockImplementation(async (method: string) => {
    switch (method) {
      case 'repo.list':
        return reply({ repos })
      case 'ssh.listTargetSummaries':
        return reply({ targets: [{ id: 'devbox', label: 'devbox', ...args.sshTarget }] })
      case 'host.platform':
        return reply({ platform: 'darwin' })
      default:
        return reply({})
    }
  })
  const seen: { rows: Worktree[]; refresh?: (options: { force: boolean }) => Promise<void> } = {
    rows: []
  }
  let setWorktrees: ((rows: Worktree[]) => void) | undefined
  function Probe(): null {
    const state = useHostScreenState('host-1', undefined)
    state.clientRef.current = client
    setWorktrees = state.setWorktrees
    seen.refresh = useHostRepoMetadata({ client, connState: 'connected', hostId: 'host-1', state })
    seen.rows = useHostDisplayWorktrees('connected', state)
    return null
  }
  await act(async () => {
    create(createElement(Probe))
  })
  await act(async () => {
    setWorktrees?.(args.rows)
    await seen.refresh?.({ force: true })
  })
  if (args.thenRepos) {
    repos = args.thenRepos
    await act(async () => {
      await seen.refresh?.({ force: true })
    })
  }
  return seen.rows
}

describe('SSH host health on the host list rows', () => {
  it('names an unreachable SSH host with its health even when every row is on it', async () => {
    const rows = await displayedRows({
      repos: [{ id: 'repo-ssh', displayName: 'api', connectionId: 'devbox' }],
      rows: [row('a', 'repo-ssh'), row('b', 'repo-ssh')],
      sshTarget: { connected: false, connectionStatus: 'disconnected' }
    })
    expect(rows.map((r) => [r.hostContextLabel, r.hostContextHealthLabel])).toEqual([
      ['devbox', 'Disconnected'],
      ['devbox', 'Disconnected']
    ])
  })

  it('carries the health beside the label in a mixed-host list', async () => {
    const rows = await displayedRows({
      repos: [
        { id: 'repo-local', displayName: 'web' },
        { id: 'repo-ssh', displayName: 'api', connectionId: 'devbox' }
      ],
      rows: [row('a', 'repo-local'), row('b', 'repo-ssh')],
      sshTarget: { connected: false, connectionStatus: 'reconnecting' }
    })
    expect(rows.map((r) => r.hostContextHealthLabel)).toEqual([undefined, 'Connecting'])
  })

  it('drops the badge once the SSH host leaves the catalog', async () => {
    const rows = await displayedRows({
      repos: [{ id: 'repo-ssh', displayName: 'api', connectionId: 'devbox' }],
      rows: [{ ...row('a', 'repo-ssh'), hostId: 'ssh:devbox' }],
      sshTarget: { connected: false, connectionStatus: 'disconnected' },
      thenRepos: [{ id: 'repo-local', displayName: 'web' }]
    })
    expect(rows[0].hostContextLabel).toBeUndefined()
    expect(rows[0].hostContextHealthLabel).toBeUndefined()
  })

  it('keeps a healthy single-host list bare', async () => {
    const rows = await displayedRows({
      repos: [{ id: 'repo-ssh', displayName: 'api', connectionId: 'devbox' }],
      rows: [row('a', 'repo-ssh')],
      sshTarget: { connected: true, connectionStatus: 'connected' }
    })
    expect(rows[0].hostContextLabel).toBeUndefined()
    expect(rows[0].hostContextHealthLabel).toBeUndefined()
  })
})
