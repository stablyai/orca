import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { ipcMain } from 'electron'
import type { Store } from '../persistence'
import type {
  RemoteWorkspaceSession,
  RemoteWorkspaceSnapshot
} from '../../shared/remote-workspace-types'
import type { SshTarget } from '../../shared/ssh-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

const {
  getActiveMultiplexerMock,
  getSshConnectionStoreMock,
  registerRemoteWorkspaceNotificationHandlerMock
} = vi.hoisted(() => ({
  getActiveMultiplexerMock: vi.fn(),
  getSshConnectionStoreMock: vi.fn(),
  registerRemoteWorkspaceNotificationHandlerMock: vi.fn(() => vi.fn())
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

import {
  _resetRemoteWorkspaceCachesForTests,
  _getRemoteWorkspaceTabIntentStateForTests,
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
  const store = {
    getRepo: getRepoMock,
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
      listTargets: () => targets
    })
    getRepoMock.mockReset()
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

  it('writes only to explicitly hydrated connected targets', async () => {
    const result = await callSetForConnectedTargets({
      session: baseSession,
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
            ptyId: 'pty-store',
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
})

describe('remote workspace tab observation IPC ownership', () => {
  it('requires the main Electron sender, hydration, and its current process generation', async () => {
    const handlers = new Map<string, (event: never, args?: never) => unknown>()
    vi.mocked(ipcMain.handle).mockReset()
    vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
      handlers.set(channel, handler as (event: never, args?: never) => unknown)
    })
    _resetRemoteWorkspaceCachesForTests()
    const mainSender = Object.assign(new EventEmitter(), { id: 7 })
    const otherSender = Object.assign(new EventEmitter(), { id: 8 })
    registerRemoteWorkspaceHandlers({} as Store, () => ({ webContents: mainSender }) as never)
    const start = handlers.get('remoteWorkspace:startTabStateObservation')!
    const observe = handlers.get('remoteWorkspace:observeTabState')!
    const event = (sender: typeof mainSender, processId: number) => ({ processId, sender }) as never
    const observation = (generation: number, tabs: string[], hydrated = true) =>
      ({
        hydrated,
        rendererGeneration: generation,
        targetId: 'target-owned',
        worktrees: [
          {
            worktreeId: 'repo::/remote/work',
            worktreeInstanceId: 'worktree-1',
            worktreePath: '/remote/work',
            tabs: tabs.map((id, index) => ({
              processIdentity: `process-${id}`,
              tab: {
                id,
                worktreePath: '/remote/work',
                ptyId: `pty-${id}`,
                title: id,
                customTitle: null,
                color: null,
                sortOrder: 0,
                createdAt: index + 1
              }
            }))
          }
        ]
      }) as never

    expect(start(event(otherSender, 10))).toBe(0)
    const first = start(event(mainSender, 10)) as number
    expect(() =>
      observe(event(mainSender, 10), {
        hydrated: true,
        rendererGeneration: first,
        targetId: 'target-owned',
        worktrees: null
      } as never)
    ).not.toThrow()
    await observe(event(mainSender, 10), observation(first, [], false))
    expect(_getRemoteWorkspaceTabIntentStateForTests('target-owned')).toBeNull()
    await observe(event(mainSender, 10), observation(first, ['existing']))

    const second = start(event(mainSender, 11)) as number
    await observe(event(mainSender, 11), observation(second, ['existing']))
    await observe(event(mainSender, 10), observation(first, ['existing', 'stale']))
    await observe(event(mainSender, 11), observation(999_999, ['existing', 'forged']))

    expect(_getRemoteWorkspaceTabIntentStateForTests('target-owned')).toEqual({
      intents: 0,
      overflowed: false
    })
  })
})
