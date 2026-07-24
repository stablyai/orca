import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import type { Store } from '../persistence'
import type {
  RemoteWorkspaceSession,
  RemoteWorkspaceSnapshot
} from '../../shared/remote-workspace-types'
import type { SshTarget } from '../../shared/ssh-types'
import type { WorkspaceSessionState } from '../../shared/types'

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
  REMOTE_WORKSPACE_PATCH_CONCURRENCY,
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

  it.each([
    ['at the limit', REMOTE_WORKSPACE_PATCH_CONCURRENCY],
    ['above the limit', REMOTE_WORKSPACE_PATCH_CONCURRENCY + 1]
  ])('bounds per-target workspace patches %s', async (_, count) => {
    const manyTargets: SshTarget[] = Array.from({ length: count }, (_, index) => ({
      id: `target-${index}`,
      label: `Target ${index}`,
      host: `${index}.example.com`,
      port: 22,
      username: 'alice'
    }))
    getSshConnectionStoreMock.mockReturnValue({ listTargets: () => manyTargets })
    let active = 0
    let peak = 0
    let started = 0
    const releases: (() => void)[] = []
    getActiveMultiplexerMock.mockImplementation(() => ({
      request: async (method: string) => {
        if (method === 'workspace.get') {
          started++
          active++
          peak = Math.max(peak, active)
          await new Promise<void>((resolve) => releases.push(resolve))
          active--
          return snapshot({
            activeWorktreePath: '/previous',
            activeTabId: null,
            tabsByWorktreePath: {},
            terminalLayoutsByTabId: {}
          })
        }
        return {
          ok: true,
          snapshot: snapshot({
            activeWorktreePath: null,
            activeTabId: null,
            tabsByWorktreePath: {},
            terminalLayoutsByTabId: {}
          })
        }
      }
    }))

    const patches = callSetForConnectedTargets({
      session: baseSession,
      hydratedTargetIds: manyTargets.map((target) => target.id)
    })
    await vi.waitFor(() =>
      expect(started).toBe(Math.min(count, REMOTE_WORKSPACE_PATCH_CONCURRENCY))
    )
    if (count > REMOTE_WORKSPACE_PATCH_CONCURRENCY) {
      releases.shift()?.()
      await vi.waitFor(() => expect(started).toBe(count))
    }
    releases.splice(0).forEach((release) => release())

    await expect(patches).resolves.toHaveLength(count)
    expect(peak).toBe(Math.min(count, REMOTE_WORKSPACE_PATCH_CONCURRENCY))
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
