import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import type { Store } from '../persistence'
import type {
  RemoteWorkspaceSession,
  RemoteWorkspaceSnapshot
} from '../../shared/remote-workspace-types'
import type { DirectSshAuthority, SshProviderEpoch, SshTarget } from '../../shared/ssh-types'
import type { WorkspaceSessionState } from '../../shared/types'

const {
  getActiveMultiplexerMock,
  getSshConnectionStoreMock,
  getSshProviderAuthorityMock,
  isCurrentSshProviderAuthorityMock,
  registerRemoteWorkspaceNotificationHandlerMock
} = vi.hoisted(() => ({
  getActiveMultiplexerMock: vi.fn(),
  getSshConnectionStoreMock: vi.fn(),
  getSshProviderAuthorityMock: vi.fn((targetId: string) => ({
    targetId,
    providerEpoch: `epoch-${targetId}`,
    connectionGeneration: 1
  })),
  isCurrentSshProviderAuthorityMock: vi.fn((_candidate: DirectSshAuthority) => true),
  registerRemoteWorkspaceNotificationHandlerMock: vi.fn(
    (
      _handler: (
        targetId: string,
        method: string,
        params: Record<string, unknown>,
        authority: DirectSshAuthority
      ) => void
    ) => vi.fn()
  )
}))

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

vi.mock('../ssh/ssh-provider-authority', () => ({
  getSshProviderAuthority: getSshProviderAuthorityMock,
  isCurrentSshProviderAuthority: isCurrentSshProviderAuthorityMock
}))

import {
  _getRemoteWorkspaceSnapshotForTests,
  _resetRemoteWorkspaceCachesForTests,
  registerRemoteWorkspaceHandlers,
  remoteWorkspaceSessionMatchesSnapshot
} from './remote-workspace'

function snapshot(session: RemoteWorkspaceSession, revision = 7): RemoteWorkspaceSnapshot {
  return {
    namespace: 'target',
    revision,
    updatedAt: 123,
    schemaVersion: 1,
    session
  }
}

function emptyRemoteSession(): RemoteWorkspaceSession {
  return {
    activeWorktreePath: null,
    activeTabId: null,
    tabsByWorktreePath: {},
    terminalLayoutsByTabId: {}
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

function authority(targetId: string): DirectSshAuthority {
  return {
    targetId,
    providerEpoch: `epoch-${targetId}` as SshProviderEpoch,
    connectionGeneration: 1
  }
}

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
  const patchWorkspaceSessionMock = vi.fn<Store['patchWorkspaceSession']>()
  const store = {
    getRepo: getRepoMock,
    getWorkspaceSession: getWorkspaceSessionMock,
    patchWorkspaceSession: patchWorkspaceSessionMock
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
      listTargets: () => targets
    })
    getRepoMock.mockReset()
    getSshProviderAuthorityMock.mockClear()
    isCurrentSshProviderAuthorityMock.mockReset()
    isCurrentSshProviderAuthorityMock.mockReturnValue(true)
    getWorkspaceSessionMock.mockReset()
    getWorkspaceSessionMock.mockReturnValue(baseSession)
    patchWorkspaceSessionMock.mockReset()
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
    sessionTargetId?: string
    sessionAuthority?: DirectSshAuthority
    hydratedTargetIds?: unknown
  }): Promise<unknown> {
    const handler = handlers.get('remoteWorkspace:setForConnectedTargets')
    if (!handler) {
      throw new Error('remoteWorkspace:setForConnectedTargets handler was never registered')
    }
    return handler(null, args)
  }

  it('does not write without an explicit non-empty hydrated target set', async () => {
    await expect(callSetForConnectedTargets({ session: baseSession })).resolves.toEqual([])
    await expect(
      callSetForConnectedTargets({ session: baseSession, hydratedTargetIds: [] })
    ).resolves.toEqual([])
    await expect(
      callSetForConnectedTargets({ session: baseSession, hydratedTargetIds: ['target-1', 42] })
    ).resolves.toEqual([])

    expect(getSshConnectionStoreMock).not.toHaveBeenCalled()
    expect(getActiveMultiplexerMock).not.toHaveBeenCalled()
  })

  it('rejects a late workspace notification from replaced provider authority', () => {
    const currentAuthority = authority('target-1')
    const staleAuthority = {
      ...currentAuthority,
      providerEpoch: 'stale-epoch' as SshProviderEpoch,
      connectionGeneration: 0
    }
    getSshConnectionStoreMock.mockReturnValue({
      listTargets: () => targets,
      getTarget: (targetId: string) => targets.find((target) => target.id === targetId)
    })
    isCurrentSshProviderAuthorityMock.mockImplementation(
      (candidate: DirectSshAuthority) =>
        candidate.providerEpoch === currentAuthority.providerEpoch &&
        candidate.connectionGeneration === currentAuthority.connectionGeneration
    )
    const notificationHandler =
      registerRemoteWorkspaceNotificationHandlerMock.mock.calls.at(-1)?.[0]
    expect(notificationHandler).toBeTypeOf('function')

    notificationHandler?.(
      'target-1',
      'workspace.changed',
      { snapshot: snapshot({ ...emptyRemoteSession(), activeWorktreePath: '/stale' }, 99) },
      staleAuthority
    )
    expect(_getRemoteWorkspaceSnapshotForTests(currentAuthority)).toBeUndefined()

    notificationHandler?.(
      'target-1',
      'workspace.changed',
      { snapshot: snapshot({ ...emptyRemoteSession(), activeWorktreePath: '/current' }, 4) },
      currentAuthority
    )
    expect(_getRemoteWorkspaceSnapshotForTests(currentAuthority)?.revision).toBe(4)
  })

  it('does not export an explicit session without target provenance', async () => {
    await expect(
      callSetForConnectedTargets({ session: baseSession, hydratedTargetIds: ['target-1'] })
    ).resolves.toEqual([])

    expect(getSshConnectionStoreMock).not.toHaveBeenCalled()
    expect(getActiveMultiplexerMock).not.toHaveBeenCalled()
  })

  it('rejects missing, conflicting, and stale explicit provider authority', async () => {
    await expect(
      callSetForConnectedTargets({
        session: baseSession,
        sessionTargetId: 'target-1',
        hydratedTargetIds: ['target-1']
      })
    ).resolves.toEqual([])
    await expect(
      callSetForConnectedTargets({
        session: baseSession,
        sessionTargetId: 'target-1',
        sessionAuthority: authority('target-2'),
        hydratedTargetIds: ['target-1']
      })
    ).resolves.toEqual([])
    isCurrentSshProviderAuthorityMock.mockReturnValue(false)
    await expect(
      callSetForConnectedTargets({
        session: baseSession,
        sessionTargetId: 'target-1',
        sessionAuthority: authority('target-1'),
        hydratedTargetIds: ['target-1']
      })
    ).resolves.toEqual([])

    expect(getSshConnectionStoreMock).not.toHaveBeenCalled()
  })

  it('writes only to explicitly hydrated connected targets', async () => {
    const result = await callSetForConnectedTargets({
      session: baseSession,
      sessionTargetId: 'target-1',
      sessionAuthority: authority('target-1'),
      hydratedTargetIds: ['target-1', 'missing-target']
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
            ptyId: 'ssh:target-1@@pty-store',
            worktreeId: 'repo-target-1::/repo'
          } as never
        ]
      },
      terminalLayoutsByTabId: {}
    })

    await callSetForConnectedTargets({ hydratedTargetIds: ['target-1'] })

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

  it('exports tabs stranded in the target ssh partition when the local partition is empty', async () => {
    const worktreeId = 'repo-target-1::/repo'
    getWorkspaceSessionMock.mockImplementation((hostId?: string | null) => {
      if (hostId === 'ssh:target-1') {
        return {
          ...baseSession,
          tabsByWorktree: {
            [worktreeId]: [
              {
                id: 'stranded-tab',
                title: 'Stranded shell',
                ptyId: null,
                worktreeId
              } as never
            ]
          }
        }
      }
      return { ...baseSession, tabsByWorktree: { [worktreeId]: [] } }
    })

    await callSetForConnectedTargets({ hydratedTargetIds: ['target-1'] })

    expect(getWorkspaceSessionMock).toHaveBeenCalledWith('ssh:target-1')
    expect(requestByTargetId.get('target-1')).toHaveBeenCalledWith(
      'workspace.patch',
      expect.objectContaining({
        patch: expect.objectContaining({
          session: expect.objectContaining({
            tabsByWorktreePath: {
              '/repo': [expect.objectContaining({ id: 'stranded-tab' })]
            }
          })
        })
      })
    )
    // Adoption on this path is read-only: the renderer owns the local
    // partition, so a store-side move here would be undone by its next write.
    expect(patchWorkspaceSessionMock).not.toHaveBeenCalled()
  })

  it('qualifies duplicate repository ids by SSH target during export', async () => {
    const worktreeId = 'duplicate::/repo'
    getRepoMock.mockImplementation((repoId: string, hostId?: string) => {
      if (repoId !== 'duplicate' || !hostId?.startsWith('ssh:')) {
        return undefined
      }
      return {
        id: repoId,
        path: '/repo',
        displayName: 'Duplicate',
        badgeColor: 'blue',
        addedAt: 1,
        connectionId: hostId.slice(4),
        executionHostId: hostId
      } as never
    })
    getWorkspaceSessionMock.mockImplementation((hostId?: string | null) => ({
      ...baseSession,
      tabsByWorktree:
        hostId === 'ssh:target-1' || hostId === 'ssh:target-2'
          ? {
              [worktreeId]: [
                {
                  id: `${hostId}-tab`,
                  title: hostId,
                  ptyId: null,
                  worktreeId
                } as never
              ]
            }
          : { [worktreeId]: [] }
    }))

    await callSetForConnectedTargets({ hydratedTargetIds: ['target-1', 'target-2'] })

    for (const targetId of ['target-1', 'target-2']) {
      expect(getRepoMock).toHaveBeenCalledWith('duplicate', `ssh:${targetId}`)
      expect(requestByTargetId.get(targetId)).toHaveBeenCalledWith(
        'workspace.patch',
        expect.objectContaining({
          patch: expect.objectContaining({
            session: expect.objectContaining({
              tabsByWorktreePath: {
                '/repo': [expect.objectContaining({ id: `ssh:${targetId}-tab` })]
              }
            })
          })
        })
      )
    }
  })

  it('fails closed when local and target partitions conflict on one workspace key', async () => {
    const worktreeId = 'duplicate::/repo'
    getRepoMock.mockImplementation((repoId: string, hostId?: string) =>
      repoId === 'duplicate' && hostId === 'ssh:target-2'
        ? ({ id: repoId, connectionId: 'target-2', executionHostId: hostId } as never)
        : undefined
    )
    getWorkspaceSessionMock.mockImplementation((hostId?: string | null) => ({
      ...baseSession,
      tabsByWorktree: {
        [worktreeId]: [
          {
            id: hostId === 'ssh:target-2' ? 'target-b-tab' : 'target-a-tab',
            title: hostId ?? 'local',
            ptyId: null,
            worktreeId
          } as never
        ]
      },
      terminalTopologyRevisionByRepoId: { duplicate: 4 }
    }))

    await expect(callSetForConnectedTargets({ hydratedTargetIds: ['target-2'] })).resolves.toEqual(
      []
    )

    expect(getWorkspaceSessionMock).toHaveBeenCalledWith('ssh:target-2')
    expect(requestByTargetId.get('target-2')).not.toHaveBeenCalledWith(
      'workspace.patch',
      expect.anything()
    )
  })

  it('fences a transient explicit PTY loss while allowing matching durable target state', async () => {
    const worktreeId = 'repo-target-1::/repo'
    getWorkspaceSessionMock.mockImplementation((hostId?: string | null) => {
      if (hostId !== undefined) {
        return baseSession
      }
      return {
        ...baseSession,
        tabsByWorktree: {
          [worktreeId]: [
            {
              id: 'tab-explicit',
              title: 'Shell',
              ptyId: 'ssh:target-1@@pty-durable',
              worktreeId
            } as never
          ]
        },
        terminalLayoutsByTabId: {
          'tab-explicit': {
            root: { type: 'leaf', id: 'leaf-1' },
            ptyIdsByLeafId: { 'leaf-1': 'ssh:target-1@@pty-durable' }
          } as never
        }
      }
    })

    await expect(
      callSetForConnectedTargets({
        session: {
          ...baseSession,
          tabsByWorktree: {
            [worktreeId]: [{ id: 'tab-explicit', title: 'Shell', ptyId: null, worktreeId } as never]
          },
          terminalLayoutsByTabId: {
            'tab-explicit': {
              root: { type: 'leaf', id: 'leaf-1' },
              ptyIdsByLeafId: {}
            } as never
          }
        },
        sessionTargetId: 'target-1',
        sessionAuthority: authority('target-1'),
        hydratedTargetIds: ['target-1']
      })
    ).resolves.toEqual([])

    expect(getWorkspaceSessionMock).toHaveBeenCalledWith()
    expect(requestByTargetId.get('target-1')).not.toHaveBeenCalledWith(
      'workspace.patch',
      expect.anything()
    )

    const session = {
      ...baseSession,
      tabsByWorktree: {
        [worktreeId]: [
          {
            id: 'tab-explicit',
            title: 'Shell',
            ptyId: 'ssh:target-1@@pty-durable',
            worktreeId
          } as never
        ]
      }
    }
    getWorkspaceSessionMock.mockImplementation((hostId?: string | null) =>
      hostId === undefined ? session : baseSession
    )

    await callSetForConnectedTargets({
      session,
      sessionTargetId: 'target-1',
      sessionAuthority: authority('target-1'),
      hydratedTargetIds: ['target-1']
    })

    expect(getWorkspaceSessionMock).toHaveBeenCalledWith()
    expect(requestByTargetId.get('target-1')).toHaveBeenCalledWith(
      'workspace.patch',
      expect.objectContaining({
        patch: expect.objectContaining({
          session: expect.objectContaining({
            tabsByWorktreePath: {
              '/repo': [expect.objectContaining({ id: 'tab-explicit' })]
            }
          })
        })
      })
    )
  })

  it('does not export a target-qualified explicit session through a conflicting target', async () => {
    const worktreeId = 'duplicate::/repo'
    await expect(
      callSetForConnectedTargets({
        session: {
          ...baseSession,
          tabsByWorktree: {
            [worktreeId]: [
              { id: 'target-a-tab', title: 'Target A', ptyId: null, worktreeId } as never
            ]
          }
        },
        sessionTargetId: 'target-1',
        sessionAuthority: authority('target-1'),
        hydratedTargetIds: ['target-2']
      })
    ).resolves.toEqual([])

    expect(getRepoMock).not.toHaveBeenCalled()
    expect(requestByTargetId.get('target-2')).toBeUndefined()
  })

  it('rejects cross-target PTYs and duplicate tab ownership before explicit export', async () => {
    const worktreeId = 'repo-target-1::/repo'
    const localWorktreeId = 'local::/local'
    const targetTab = {
      id: 'shared-tab',
      title: 'Target A',
      ptyId: 'ssh:target-2@@foreign',
      worktreeId
    }
    await expect(
      callSetForConnectedTargets({
        session: {
          ...baseSession,
          tabsByWorktree: { [worktreeId]: [targetTab as never] },
          remoteSessionIdsByTabId: { 'shared-tab': 'ssh:target-2@@foreign' }
        },
        sessionTargetId: 'target-1',
        sessionAuthority: authority('target-1'),
        hydratedTargetIds: ['target-1']
      })
    ).resolves.toEqual([])

    await expect(
      callSetForConnectedTargets({
        session: {
          ...baseSession,
          tabsByWorktree: {
            [worktreeId]: [{ ...targetTab, ptyId: 'ssh:target-1@@owned', worktreeId } as never],
            [localWorktreeId]: [{ ...targetTab, ptyId: null, worktreeId: localWorktreeId } as never]
          }
        },
        sessionTargetId: 'target-1',
        sessionAuthority: authority('target-1'),
        hydratedTargetIds: ['target-1']
      })
    ).resolves.toEqual([])

    expect(requestByTargetId.get('target-1')).not.toHaveBeenCalledWith(
      'workspace.patch',
      expect.anything()
    )
  })
})
