/* oxlint-disable max-lines -- Why: queue/cache regression cases share one mocked IPC harness so stale revision sequencing stays visible. */
import { ipcMain } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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

import { registerRemoteWorkspaceHandlers } from './remote-workspace'

function snapshot(session: RemoteWorkspaceSession, revision = 7): RemoteWorkspaceSnapshot {
  return {
    namespace: 'target',
    revision,
    updatedAt: 123,
    schemaVersion: 1,
    session
  }
}

function sessionWithTab(worktreeId: string, tabId: string): WorkspaceSessionState {
  return {
    activeRepoId: null,
    activeWorktreeId: worktreeId,
    activeTabId: tabId,
    tabsByWorktree: {
      [worktreeId]: [{ id: tabId, type: 'terminal', title: 'Shell', worktreeId } as never]
    },
    terminalLayoutsByTabId: {}
  }
}

function patchSession(params: Record<string, unknown>): RemoteWorkspaceSession {
  return (params.patch as { session: RemoteWorkspaceSession }).session
}

describe('remoteWorkspace:setForConnectedTargets patch queue', () => {
  const handlers = new Map<string, (event: unknown, args: unknown) => unknown>()
  const muxByTargetId = new Map<string, { request: ReturnType<typeof vi.fn> }>()
  const getRepoMock = vi.fn<Store['getRepo']>()
  const store = {
    getRepo: getRepoMock
  } as unknown as Store

  const target: SshTarget = {
    id: 'target-1',
    label: 'Target 1',
    host: 'one.example.com',
    port: 22,
    username: 'alice'
  }

  beforeEach(() => {
    handlers.clear()
    muxByTargetId.clear()
    vi.mocked(ipcMain.handle).mockReset()
    vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
      handlers.set(channel, handler as (event: unknown, args: unknown) => unknown)
    })
    vi.mocked(ipcMain.removeHandler).mockReset()
    getSshConnectionStoreMock.mockReset()
    getSshConnectionStoreMock.mockReturnValue({
      listTargets: () => [target]
    })
    getRepoMock.mockReset()
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
    getActiveMultiplexerMock.mockImplementation((targetId: string) => muxByTargetId.get(targetId))
    registerRemoteWorkspaceNotificationHandlerMock.mockClear()

    registerRemoteWorkspaceHandlers(store, () => null)
  })

  async function callSetForConnectedTargets(args: {
    session: WorkspaceSessionState
    hydratedTargetIds?: unknown
  }): Promise<unknown> {
    const handler = handlers.get('remoteWorkspace:setForConnectedTargets')
    if (!handler) {
      throw new Error('remoteWorkspace:setForConnectedTargets handler was never registered')
    }
    return handler(null, args)
  }

  it('serializes overlapping writes for the same target so they use fresh base revisions', async () => {
    let currentRevision = 7
    let releaseFirstPatch!: () => void
    const firstPatchCanFinish = new Promise<void>((resolve) => {
      releaseFirstPatch = resolve
    })
    const patchBaseRevisions: number[] = []
    const request = vi
      .fn()
      .mockImplementation(async (method: string, params: Record<string, unknown>) => {
        if (method === 'workspace.get') {
          return snapshot(
            {
              activeWorktreePath: '/previous',
              activeTabId: null,
              tabsByWorktreePath: {},
              terminalLayoutsByTabId: {}
            },
            currentRevision
          )
        }
        if (method === 'workspace.patch') {
          patchBaseRevisions.push(params.baseRevision as number)
          if (patchBaseRevisions.length === 1) {
            await firstPatchCanFinish
          }
          currentRevision += 1
          return {
            ok: true,
            snapshot: snapshot(patchSession(params), currentRevision)
          }
        }
        throw new Error(`Unexpected method ${method}`)
      })
    muxByTargetId.set('target-1', { request })

    const first = callSetForConnectedTargets({
      session: sessionWithTab('repo-target-1::/remote/workspace-a', 'tab-a'),
      hydratedTargetIds: ['target-1']
    })
    await vi.waitFor(() => expect(patchBaseRevisions).toEqual([7]))

    const second = callSetForConnectedTargets({
      session: sessionWithTab('repo-target-1::/remote/workspace-b', 'tab-b'),
      hydratedTargetIds: ['target-1']
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(patchBaseRevisions).toEqual([7])

    releaseFirstPatch()
    await expect(Promise.all([first, second])).resolves.toMatchObject([
      [{ targetId: 'target-1', result: { ok: true } }],
      [{ targetId: 'target-1', result: { ok: true } }]
    ])
    expect(patchBaseRevisions).toEqual([7, 8])
  })

  it('retries once when a reset relay reports a lower revision than the cached base', async () => {
    const resetTarget: SshTarget = {
      id: 'target-reset',
      label: 'Reset Target',
      host: 'reset.example.com',
      port: 22,
      username: 'alice'
    }
    getSshConnectionStoreMock.mockReturnValue({
      listTargets: () => [resetTarget]
    })
    getRepoMock.mockImplementation((repoId: string) =>
      repoId === 'repo-reset'
        ? ({
            id: 'repo-reset',
            path: '/remote/repo',
            displayName: 'Repo',
            badgeColor: 'blue',
            addedAt: 1,
            connectionId: 'target-reset'
          } as never)
        : undefined
    )

    const patchBaseRevisions: number[] = []
    const request = vi
      .fn()
      .mockImplementation(async (method: string, params: Record<string, unknown>) => {
        if (method === 'workspace.get') {
          return snapshot(
            {
              activeWorktreePath: '/previous',
              activeTabId: null,
              tabsByWorktreePath: {},
              terminalLayoutsByTabId: {}
            },
            7
          )
        }
        if (method === 'workspace.patch') {
          patchBaseRevisions.push(params.baseRevision as number)
          if (patchBaseRevisions.length === 1) {
            return {
              ok: false,
              reason: 'stale-revision',
              snapshot: snapshot(
                {
                  activeWorktreePath: null,
                  activeTabId: null,
                  tabsByWorktreePath: {},
                  terminalLayoutsByTabId: {}
                },
                0
              )
            }
          }
          return {
            ok: true,
            snapshot: snapshot(patchSession(params), 1)
          }
        }
        throw new Error(`Unexpected method ${method}`)
      })
    muxByTargetId.set('target-reset', { request })

    await expect(
      callSetForConnectedTargets({
        session: sessionWithTab('repo-reset::/remote/workspace', 'tab-reset'),
        hydratedTargetIds: ['target-reset']
      })
    ).resolves.toMatchObject([{ targetId: 'target-reset', result: { ok: true } }])
    expect(patchBaseRevisions).toEqual([7, 0])
  })

  it('does not retry stale writes when the relay reports a newer revision', async () => {
    const newerTarget: SshTarget = {
      id: 'target-newer',
      label: 'Newer Target',
      host: 'newer.example.com',
      port: 22,
      username: 'alice'
    }
    getSshConnectionStoreMock.mockReturnValue({
      listTargets: () => [newerTarget]
    })
    getRepoMock.mockImplementation((repoId: string) =>
      repoId === 'repo-newer'
        ? ({
            id: 'repo-newer',
            path: '/remote/repo',
            displayName: 'Repo',
            badgeColor: 'blue',
            addedAt: 1,
            connectionId: 'target-newer'
          } as never)
        : undefined
    )

    const patchBaseRevisions: number[] = []
    const request = vi
      .fn()
      .mockImplementation(async (method: string, params: Record<string, unknown>) => {
        if (method === 'workspace.get') {
          return snapshot(
            {
              activeWorktreePath: '/previous',
              activeTabId: null,
              tabsByWorktreePath: {},
              terminalLayoutsByTabId: {}
            },
            7
          )
        }
        if (method === 'workspace.patch') {
          patchBaseRevisions.push(params.baseRevision as number)
          return {
            ok: false,
            reason: 'stale-revision',
            snapshot: snapshot(
              {
                activeWorktreePath: '/other-device',
                activeTabId: null,
                tabsByWorktreePath: {},
                terminalLayoutsByTabId: {}
              },
              8
            )
          }
        }
        throw new Error(`Unexpected method ${method}`)
      })
    muxByTargetId.set('target-newer', { request })

    await expect(
      callSetForConnectedTargets({
        session: sessionWithTab('repo-newer::/remote/workspace', 'tab-local'),
        hydratedTargetIds: ['target-newer']
      })
    ).resolves.toMatchObject([
      { targetId: 'target-newer', result: { ok: false, reason: 'stale-revision' } }
    ])
    expect(patchBaseRevisions).toEqual([7])
  })
})
