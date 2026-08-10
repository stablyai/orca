import { ipcMain } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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
  getSshProviderAuthorityMock: vi.fn(),
  isCurrentSshProviderAuthorityMock: vi.fn(),
  registerRemoteWorkspaceNotificationHandlerMock: vi.fn(() => vi.fn())
}))

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() }
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
  _resetRemoteWorkspaceCachesForTests,
  registerRemoteWorkspaceHandlers
} from './remote-workspace'

const TARGET: SshTarget = {
  id: 'target-1',
  label: 'Target 1',
  host: 'one.example.com',
  port: 22,
  username: 'alice'
}

function authority(providerEpoch: string, connectionGeneration: number): DirectSshAuthority {
  return {
    targetId: TARGET.id,
    providerEpoch: providerEpoch as SshProviderEpoch,
    connectionGeneration
  }
}

function sessionWithTab(worktreePath: string, tabId: string): WorkspaceSessionState {
  const worktreeId = `repo-target-1::${worktreePath}`
  return {
    activeRepoId: 'repo-target-1',
    activeWorktreeId: worktreeId,
    activeTabId: tabId,
    tabsByWorktree: {
      [worktreeId]: [{ id: tabId, type: 'terminal', title: tabId, worktreeId } as never]
    },
    terminalLayoutsByTabId: {}
  }
}

function snapshot(session: RemoteWorkspaceSession, revision: number): RemoteWorkspaceSnapshot {
  return {
    namespace: 'target',
    revision,
    updatedAt: 123,
    schemaVersion: 1,
    session
  }
}

function emptyRemoteSession(activeWorktreePath: string): RemoteWorkspaceSession {
  return {
    activeWorktreePath,
    activeTabId: null,
    tabsByWorktreePath: {},
    terminalLayoutsByTabId: {}
  }
}

function patchedSession(params: Record<string, unknown>): RemoteWorkspaceSession {
  return (params.patch as { session: RemoteWorkspaceSession }).session
}

describe('remote workspace queued patch authority', () => {
  const handlers = new Map<string, (event: unknown, args: unknown) => unknown>()
  let currentAuthority = authority('epoch-1', 1)
  let currentSession = sessionWithTab('/first', 'first-tab')
  let currentMux: { request: ReturnType<typeof vi.fn> } | undefined

  beforeEach(() => {
    _resetRemoteWorkspaceCachesForTests()
    handlers.clear()
    currentAuthority = authority('epoch-1', 1)
    currentSession = sessionWithTab('/first', 'first-tab')
    currentMux = undefined
    vi.mocked(ipcMain.handle).mockReset()
    vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
      handlers.set(channel, handler as (event: unknown, args: unknown) => unknown)
    })
    vi.mocked(ipcMain.removeHandler).mockReset()
    getActiveMultiplexerMock.mockReset()
    getActiveMultiplexerMock.mockImplementation(() => currentMux)
    getSshConnectionStoreMock.mockReset()
    getSshConnectionStoreMock.mockReturnValue({ listTargets: () => [TARGET] })
    getSshProviderAuthorityMock.mockReset()
    getSshProviderAuthorityMock.mockImplementation(() => currentAuthority)
    isCurrentSshProviderAuthorityMock.mockReset()
    isCurrentSshProviderAuthorityMock.mockImplementation(
      (candidate: DirectSshAuthority) =>
        candidate.targetId === currentAuthority.targetId &&
        candidate.providerEpoch === currentAuthority.providerEpoch &&
        candidate.connectionGeneration === currentAuthority.connectionGeneration
    )
    const store = {
      getRepo: vi.fn(() => ({
        id: 'repo-target-1',
        path: '/repo',
        connectionId: TARGET.id,
        executionHostId: `ssh:${TARGET.id}`
      })),
      getWorkspaceSession: vi.fn(() => currentSession)
    } as unknown as Store
    registerRemoteWorkspaceHandlers(store, () => null)
  })

  function exportExplicit(
    session: WorkspaceSessionState,
    sessionAuthority: DirectSshAuthority
  ): Promise<unknown> {
    const handler = handlers.get('remoteWorkspace:setForConnectedTargets')
    if (!handler) {
      throw new Error('remoteWorkspace:setForConnectedTargets handler was never registered')
    }
    currentSession = session
    return handler(null, {
      session,
      sessionTargetId: TARGET.id,
      sessionAuthority,
      hydratedTargetIds: [TARGET.id]
    }) as Promise<unknown>
  }

  it('rejects stale queued authority before replacement mux use and permits retry', async () => {
    const originalAuthority = currentAuthority
    const replacementAuthority = authority('epoch-2', 2)
    let releaseFirstPatch!: () => void
    const firstPatchCanFinish = new Promise<void>((resolve) => {
      releaseFirstPatch = resolve
    })
    const originalRequest = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'workspace.get') {
        return snapshot(emptyRemoteSession('/previous'), 7)
      }
      await firstPatchCanFinish
      return { ok: true, snapshot: snapshot(patchedSession(params), 8) }
    })
    const replacementRequest = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'workspace.get') {
        return snapshot(emptyRemoteSession('/replacement'), 9)
      }
      return { ok: true, snapshot: snapshot(patchedSession(params), 10) }
    })
    currentMux = { request: originalRequest }

    const first = exportExplicit(sessionWithTab('/first', 'first-tab'), originalAuthority)
    await vi.waitFor(() =>
      expect(originalRequest.mock.calls.some(([method]) => method === 'workspace.patch')).toBe(true)
    )
    const stale = exportExplicit(sessionWithTab('/stale', 'stale-tab'), originalAuthority)
    await new Promise((resolve) => setTimeout(resolve, 0))

    currentAuthority = replacementAuthority
    currentMux = { request: replacementRequest }
    releaseFirstPatch()

    await expect(first).resolves.toMatchObject([{ targetId: TARGET.id, result: { ok: true } }])
    await expect(stale).resolves.toEqual([])
    expect(replacementRequest).not.toHaveBeenCalled()

    await expect(
      exportExplicit(sessionWithTab('/current', 'current-tab'), replacementAuthority)
    ).resolves.toMatchObject([{ targetId: TARGET.id, result: { ok: true } }])
    expect(replacementRequest).toHaveBeenCalledWith(
      'workspace.patch',
      expect.objectContaining({ patch: expect.objectContaining({ kind: 'replace-session' }) })
    )
  })
})
