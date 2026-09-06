import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import type { Store } from '../persistence'
import type {
  RemoteWorkspaceObservedSnapshot,
  RemoteWorkspaceSession,
  RemoteWorkspaceSnapshot
} from '../../shared/remote-workspace-types'
import type { SshTarget } from '../../shared/ssh-types'
import type * as WorktreeExecutionHostResolution from '../../shared/worktree-execution-host-resolution'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

const {
  getActiveMultiplexerMock,
  getSshConnectionStoreMock,
  registerRemoteWorkspaceNotificationHandlerMock,
  resolveWorktreeExecutionHostCalls
} = vi.hoisted(() => ({
  getActiveMultiplexerMock: vi.fn(),
  getSshConnectionStoreMock: vi.fn(),
  registerRemoteWorkspaceNotificationHandlerMock: vi.fn(() => vi.fn()),
  resolveWorktreeExecutionHostCalls: { count: 0 }
}))

// Counts ownership resolutions without changing any of them.
vi.mock('../../shared/worktree-execution-host-resolution', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof WorktreeExecutionHostResolution
  return {
    ...actual,
    resolveWorktreeExecutionHost: (
      ...args: Parameters<typeof actual.resolveWorktreeExecutionHost>
    ) => {
      resolveWorktreeExecutionHostCalls.count += 1
      return actual.resolveWorktreeExecutionHost(...args)
    }
  }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn()
  }
}))

vi.mock('./ssh', () => ({
  getActiveMultiplexer: getActiveMultiplexerMock,
  getSshConnectionStore: getSshConnectionStoreMock
}))

vi.mock('./remote-workspace-events', () => ({
  registerRemoteWorkspaceNotificationHandler: registerRemoteWorkspaceNotificationHandlerMock
}))

import {
  _resetRemoteWorkspaceCachesForTests,
  registerRemoteWorkspaceHandlers
} from './remote-workspace'
import { remoteWorkspaceSessionMatchesSnapshot } from './remote-workspace-snapshot-normalization'

function snapshot(session: RemoteWorkspaceSession, revision = 7): RemoteWorkspaceSnapshot {
  return {
    namespace: 'target',
    revision,
    updatedAt: 123,
    schemaVersion: 1,
    session
  }
}

const baseSession = {
  activeRepoId: null,
  activeWorktreeId: null,
  activeTabId: null,
  tabsByWorktree: {},
  terminalLayoutsByTabId: {}
} as WorkspaceSessionState

const targets: SshTarget[] = [
  {
    id: 'target-1',
    label: 'Target 1',
    host: 'one.example.com',
    port: 22,
    username: 'alice'
  },
  {
    id: 'target-2',
    label: 'Target 2',
    host: 'two.example.com',
    port: 22,
    username: 'alice'
  }
]

describe('remoteWorkspaceSessionMatchesSnapshot', () => {
  it('matches normalized equivalent sessions', () => {
    expect(
      remoteWorkspaceSessionMatchesSnapshot(
        snapshot({
          activeWorktreePath: null,
          activeTabId: null,
          tabsByWorktreePath: {},
          terminalLayoutsByTabId: {}
        }),
        {
          activeWorktreePath: null,
          activeTabId: null,
          tabsByWorktreePath: {},
          terminalLayoutsByTabId: {},
          activeWorktreePathsOnShutdown: undefined,
          activeTabIdByWorktreePath: undefined,
          remoteSessionIdsByTabId: undefined,
          lastVisitedAtByWorktreePath: undefined
        }
      )
    ).toBe(true)
  })

  it('treats empty optional projection fields as equivalent to absent fields', () => {
    expect(
      remoteWorkspaceSessionMatchesSnapshot(
        snapshot({
          activeWorktreePath: null,
          activeTabId: null,
          tabsByWorktreePath: {},
          terminalLayoutsByTabId: {},
          activeWorktreePathsOnShutdown: [],
          activeTabIdByWorktreePath: {},
          remoteSessionIdsByTabId: {},
          lastVisitedAtByWorktreePath: {}
        }),
        {
          activeWorktreePath: null,
          activeTabId: null,
          tabsByWorktreePath: {},
          terminalLayoutsByTabId: {}
        }
      )
    ).toBe(true)
  })

  it('detects actual target session changes', () => {
    expect(
      remoteWorkspaceSessionMatchesSnapshot(
        snapshot({
          activeWorktreePath: '/repo',
          activeTabId: 'tab-1',
          tabsByWorktreePath: {
            '/repo': [{ id: 'tab-1', type: 'terminal', title: 'Shell' } as never]
          },
          terminalLayoutsByTabId: {}
        }),
        {
          activeWorktreePath: '/repo',
          activeTabId: 'tab-2',
          tabsByWorktreePath: {
            '/repo': [{ id: 'tab-2', type: 'terminal', title: 'Shell 2' } as never]
          },
          terminalLayoutsByTabId: {}
        }
      )
    ).toBe(false)
  })
})

describe('remoteWorkspace:setForConnectedTargets', () => {
  const handlers = new Map<string, (event: unknown, args: unknown) => unknown>()
  const requestByTargetId = new Map<string, ReturnType<typeof vi.fn>>()
  const muxByTargetId = new Map<string, { request: ReturnType<typeof vi.fn> }>()
  const getRepoMock = vi.fn<Store['getRepo']>()
  const getWorkspaceSessionMock = vi.fn<Store['getWorkspaceSession']>()
  // Ownership resolution reads the catalog, not one id-keyed row, so the fake has to project one.
  const getReposMock = vi.fn(() => [getRepoMock('repo-target-1')].filter(Boolean))
  const store = {
    getRepo: getRepoMock,
    getRepos: getReposMock,
    getWorkspaceSession: getWorkspaceSessionMock
  } as unknown as Store

  beforeEach(() => {
    _resetRemoteWorkspaceCachesForTests()
    handlers.clear()
    requestByTargetId.clear()
    muxByTargetId.clear()
    vi.mocked(ipcMain.handle).mockReset()
    vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
      handlers.set(channel, handler as (event: unknown, args: unknown) => unknown)
    })
    vi.mocked(ipcMain.removeHandler).mockReset()
    getSshConnectionStoreMock.mockReset()
    getSshConnectionStoreMock.mockReturnValue({
      listTargets: () => targets,
      getTarget: (targetId: string) => targets.find((target) => target.id === targetId)
    })
    getRepoMock.mockReset()
    getReposMock.mockClear()
    getWorkspaceSessionMock.mockReset()
    getWorkspaceSessionMock.mockReturnValue(baseSession)
    getRepoMock.mockImplementation((repoId: string) =>
      repoId === 'repo-target-1'
        ? ({
            id: 'repo-target-1',
            path: '/remote/repo',
            displayName: 'Repo',
            badgeColor: 'blue',
            addedAt: 1,
            connectionId: 'target-1'
          } as never)
        : undefined
    )
    getActiveMultiplexerMock.mockReset()
    getActiveMultiplexerMock.mockImplementation((targetId: string) => {
      let mux = muxByTargetId.get(targetId)
      if (!mux) {
        const request = vi.fn().mockImplementation((method: string) => {
          if (method === 'workspace.get') {
            return Promise.resolve(
              snapshot({
                activeWorktreePath: '/previous',
                activeTabId: null,
                tabsByWorktreePath: {},
                terminalLayoutsByTabId: {}
              })
            )
          }
          return Promise.resolve({
            ok: true,
            snapshot: snapshot({
              activeWorktreePath: null,
              activeTabId: null,
              tabsByWorktreePath: {},
              terminalLayoutsByTabId: {}
            })
          })
        })
        mux = { request }
        muxByTargetId.set(targetId, mux)
        requestByTargetId.set(targetId, request)
      }
      return mux
    })
    registerRemoteWorkspaceNotificationHandlerMock.mockClear()

    registerRemoteWorkspaceHandlers(store, () => null)
  })

  async function callSetForConnectedTargets(args: {
    session?: WorkspaceSessionState
    hydratedTargetIds?: unknown
    expectedRevisionsByTargetId?: unknown
    expectedHostObservationTokensByTargetId?: unknown
  }): Promise<unknown> {
    const handler = handlers.get('remoteWorkspace:setForConnectedTargets')
    if (!handler) {
      throw new Error('remoteWorkspace:setForConnectedTargets handler was never registered')
    }
    return handler(null, args)
  }

  async function observeTarget(targetId: string): Promise<RemoteWorkspaceObservedSnapshot> {
    const handler = handlers.get('remoteWorkspace:get')
    if (!handler) {
      throw new Error('remoteWorkspace:get handler was never registered')
    }
    const observed = await handler(null, { targetId })
    if (!observed || typeof observed !== 'object' || !('hostObservationToken' in observed)) {
      throw new Error(`remoteWorkspace:get did not observe ${targetId}`)
    }
    return observed as RemoteWorkspaceObservedSnapshot
  }

  it('reads the repo catalog once per publish, not once per worktree', async () => {
    // `store.getRepos()` re-hydrates every repo row. The export asks "is this worktree mine?" once
    // per worktree, so reading the catalog inside that callback multiplied hydration by the
    // worktree count — 413 on the session that surfaced this.
    const worktrees = Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [`repo-target-1::/remote/repo-${index}`, []])
    )
    getWorkspaceSessionMock.mockReturnValue({
      ...baseSession,
      tabsByWorktree: worktrees
    } as WorkspaceSessionState)
    const observed = await observeTarget('target-1')
    getReposMock.mockClear()

    await callSetForConnectedTargets({
      hydratedTargetIds: ['target-1'],
      expectedRevisionsByTargetId: { 'target-1': observed.revision },
      expectedHostObservationTokensByTargetId: {
        'target-1': observed.hostObservationToken
      }
    })

    expect(getReposMock).toHaveBeenCalledTimes(1)
  })

  it('resolves each worktree ownership once for the whole publish, not once per target', async () => {
    // Ownership is a function of the repo catalog alone; only the final `=== targetId` differs, so
    // exporting to N targets used to repeat the identical resolution N times per worktree key.
    const worktrees = Object.fromEntries(
      Array.from({ length: 6 }, (_, index) => [`repo-target-1::/remote/repo-${index}`, []])
    )
    getWorkspaceSessionMock.mockReturnValue({
      ...baseSession,
      tabsByWorktree: worktrees
    } as WorkspaceSessionState)
    const observed = await Promise.all(targets.map((target) => observeTarget(target.id)))
    getReposMock.mockClear()
    resolveWorktreeExecutionHostCalls.count = 0

    await callSetForConnectedTargets({
      hydratedTargetIds: targets.map((target) => target.id),
      expectedRevisionsByTargetId: Object.fromEntries(
        targets.map((target, index) => [target.id, observed[index].revision])
      ),
      expectedHostObservationTokensByTargetId: Object.fromEntries(
        targets.map((target, index) => [target.id, observed[index].hostObservationToken])
      )
    })

    expect(getReposMock).toHaveBeenCalledTimes(1)
    // 6 worktree keys resolved once each, regardless of how many targets are published to.
    expect(resolveWorktreeExecutionHostCalls.count).toBe(6)
  })

  it('skips the session and repo-catalog reads when no hydrated target is connected', async () => {
    // A hydrated but disconnected target leaves nothing to project onto, so hoisting the catalog
    // read must not make the idle path pay for a full repo hydration it never used before.
    getActiveMultiplexerMock.mockReturnValue(undefined)
    getReposMock.mockClear()
    getWorkspaceSessionMock.mockClear()

    await expect(
      callSetForConnectedTargets({
        hydratedTargetIds: ['target-1'],
        expectedRevisionsByTargetId: { 'target-1': 7 },
        expectedHostObservationTokensByTargetId: { 'target-1': 'token' }
      })
    ).resolves.toEqual([])

    expect(getReposMock).not.toHaveBeenCalled()
    expect(getWorkspaceSessionMock).not.toHaveBeenCalled()
  })

  it('does not write without an explicit non-empty hydrated target set', async () => {
    await expect(callSetForConnectedTargets({ session: baseSession })).resolves.toEqual([])
    await expect(
      callSetForConnectedTargets({ session: baseSession, hydratedTargetIds: [] })
    ).resolves.toEqual([])
    await expect(
      callSetForConnectedTargets({ session: baseSession, hydratedTargetIds: ['target-1', 42] })
    ).resolves.toEqual([])
    await expect(
      callSetForConnectedTargets({ session: baseSession, hydratedTargetIds: ['target-1'] })
    ).resolves.toEqual([])
    await expect(
      callSetForConnectedTargets({
        session: baseSession,
        hydratedTargetIds: ['target-1'],
        expectedRevisionsByTargetId: { 'target-1': 7 }
      })
    ).resolves.toEqual([])

    expect(getSshConnectionStoreMock).not.toHaveBeenCalled()
    expect(getActiveMultiplexerMock).not.toHaveBeenCalled()
  })

  it('writes only to explicitly hydrated connected targets', async () => {
    const observation = await observeTarget('target-1')
    const result = await callSetForConnectedTargets({
      session: baseSession,
      hydratedTargetIds: ['target-1', 'missing-target'],
      expectedRevisionsByTargetId: { 'target-1': 7, 'missing-target': 7 },
      expectedHostObservationTokensByTargetId: {
        'target-1': observation.hostObservationToken,
        'missing-target': 'unreachable-target-observation'
      }
    })

    expect(result).toMatchObject([{ targetId: 'target-1', result: { ok: true } }])
    expect(getActiveMultiplexerMock).toHaveBeenCalledWith('target-1')
    expect(getActiveMultiplexerMock).not.toHaveBeenCalledWith('target-2')
    expect(requestByTargetId.get('target-1')).toHaveBeenCalledWith(
      'workspace.patch',
      expect.objectContaining({
        patch: expect.objectContaining({ kind: 'replace-session' })
      })
    )
    expect(requestByTargetId.get('target-2')).toBeUndefined()
  })

  it('can export from the persisted store session when no session argument is provided', async () => {
    getWorkspaceSessionMock.mockReturnValue({
      activeRepoId: 'repo-target-1',
      activeWorktreeId: 'repo-target-1::/repo',
      activeTabId: 'tab-store',
      tabsByWorktree: {
        'repo-target-1::/repo': [
          {
            id: 'tab-store',
            title: 'Store shell',
            ptyId: 'pty-store',
            worktreeId: 'repo-target-1::/repo'
          } as never
        ]
      },
      terminalLayoutsByTabId: {}
    })

    const observation = await observeTarget('target-1')
    await callSetForConnectedTargets({
      hydratedTargetIds: ['target-1'],
      expectedRevisionsByTargetId: { 'target-1': 7 },
      expectedHostObservationTokensByTargetId: {
        'target-1': observation.hostObservationToken
      }
    })

    expect(requestByTargetId.get('target-1')).toHaveBeenCalledWith(
      'workspace.patch',
      expect.objectContaining({
        patch: expect.objectContaining({
          session: expect.objectContaining({
            activeWorktreePath: '/repo',
            activeTabId: 'tab-store'
          })
        })
      })
    )
  })

  it('does not invalidate an upload authority when an unchanged snapshot is polled', async () => {
    const first = await observeTarget('target-1')
    const second = await observeTarget('target-1')
    expect(second.hostObservationToken).toBe(first.hostObservationToken)

    const result = await callSetForConnectedTargets({
      session: baseSession,
      hydratedTargetIds: ['target-1'],
      expectedRevisionsByTargetId: { 'target-1': first.revision },
      expectedHostObservationTokensByTargetId: {
        'target-1': first.hostObservationToken
      }
    })

    expect(result).toMatchObject([{ targetId: 'target-1', result: { ok: true } }])
  })
})
