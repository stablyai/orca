import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import type { Store } from '../persistence'
import type {
  RemoteWorkspaceSession,
  RemoteWorkspaceSnapshot
} from '../../shared/remote-workspace-types'
import type { SshTarget } from '../../shared/ssh-types'

const { getActiveMultiplexerMock, getSshConnectionStoreMock } = vi.hoisted(() => ({
  getActiveMultiplexerMock: vi.fn(),
  getSshConnectionStoreMock: vi.fn()
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
  registerRemoteWorkspaceNotificationHandler: vi.fn(() => vi.fn())
}))

import {
  _resetRemoteWorkspaceCachesForTests,
  handleRemoteWorkspaceNotification,
  registerRemoteWorkspaceHandlers
} from './remote-workspace'
import { CLIENT_ID } from './remote-workspace-client-identity'
import { getCachedRemoteWorkspaceSnapshot } from './remote-workspace-snapshot-cache'

const target: SshTarget = {
  id: 'target-1',
  label: 'Target 1',
  host: 'one.example.com',
  port: 22,
  username: 'alice'
}

function snapshot(path: string, revision: number): RemoteWorkspaceSnapshot {
  const session: RemoteWorkspaceSession = {
    activeWorktreePath: path,
    activeTabId: null,
    tabsByWorktreePath: {},
    terminalLayoutsByTabId: {}
  }
  return {
    namespace: 'target',
    revision,
    updatedAt: 123,
    schemaVersion: 1,
    session
  }
}

describe('workspace.refreshRequired notifications', () => {
  const send = vi.fn()
  const request = vi.fn()
  const store = {} as Store

  beforeEach(() => {
    _resetRemoteWorkspaceCachesForTests()
    send.mockReset()
    request.mockReset()
    request.mockResolvedValue(snapshot('/latest', 7))
    getActiveMultiplexerMock.mockReset()
    getActiveMultiplexerMock.mockReturnValue({ request })
    getSshConnectionStoreMock.mockReset()
    getSshConnectionStoreMock.mockReturnValue({
      getTarget: (targetId: string) => (targetId === target.id ? target : undefined),
      listTargets: () => [target]
    })
    vi.mocked(ipcMain.handle).mockReset()
    vi.mocked(ipcMain.removeHandler).mockReset()
    registerRemoteWorkspaceHandlers(
      store,
      () =>
        ({
          isDestroyed: () => false,
          webContents: { send }
        }) as never
    )
  })

  it('pulls and publishes a snapshot after an oversized notification fallback', async () => {
    handleRemoteWorkspaceNotification(target.id, 'workspace.refreshRequired', {
      revision: 7,
      sourceClientId: 'client-b'
    })

    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith('workspace.get', { namespace: expect.any(String) })
      expect(send).toHaveBeenCalledWith(
        'remoteWorkspace:changed',
        expect.objectContaining({
          targetId: target.id,
          snapshot: expect.objectContaining({ revision: 7 })
        })
      )
    })
  })

  it('does not pull a fallback produced by this client', async () => {
    handleRemoteWorkspaceNotification(target.id, 'workspace.refreshRequired', {
      revision: 7,
      sourceClientId: CLIENT_ID
    })
    await Promise.resolve()

    expect(getActiveMultiplexerMock).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('retries when the first snapshot is below the requested revision', async () => {
    request
      .mockResolvedValueOnce(snapshot('/stale', 6))
      .mockResolvedValueOnce(snapshot('/latest', 7))

    handleRemoteWorkspaceNotification(target.id, 'workspace.refreshRequired', {
      revision: 7,
      sourceClientId: 'client-b'
    })

    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(send).toHaveBeenCalledWith(
      'remoteWorkspace:changed',
      expect.objectContaining({ snapshot: expect.objectContaining({ revision: 7 }) })
    )
  })

  it('stops retrying when snapshots remain below the requested revision', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    request.mockResolvedValue(snapshot('/stale', 6))

    handleRemoteWorkspaceNotification(target.id, 'workspace.refreshRequired', {
      revision: 7,
      sourceClientId: 'client-b'
    })

    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(4))
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          'Snapshot for target-1 remained at revision 6 below required revision 7 after 3 retries'
        )
      )
    )
    expect(send).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('resets the retry budget when a newer revision is requested', async () => {
    request
      .mockResolvedValueOnce(snapshot('/stale-1', 6))
      .mockResolvedValueOnce(snapshot('/stale-2', 6))
      .mockResolvedValueOnce(snapshot('/stale-3', 6))
      .mockResolvedValueOnce(snapshot('/revision-7', 7))
      .mockResolvedValueOnce(snapshot('/revision-8', 8))

    handleRemoteWorkspaceNotification(target.id, 'workspace.refreshRequired', {
      revision: 7,
      sourceClientId: 'client-b'
    })
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3))

    handleRemoteWorkspaceNotification(target.id, 'workspace.refreshRequired', {
      revision: 8,
      sourceClientId: 'client-b'
    })

    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(5))
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(send).toHaveBeenCalledWith(
      'remoteWorkspace:changed',
      expect.objectContaining({ snapshot: expect.objectContaining({ revision: 8 }) })
    )
  })

  it('does not let an in-flight refresh overwrite a newer direct snapshot', async () => {
    let resolveRefresh: ((value: RemoteWorkspaceSnapshot) => void) | undefined
    request.mockReturnValueOnce(
      new Promise<RemoteWorkspaceSnapshot>((resolve) => {
        resolveRefresh = resolve
      })
    )

    handleRemoteWorkspaceNotification(target.id, 'workspace.refreshRequired', {
      revision: 7,
      sourceClientId: 'client-b'
    })
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))

    handleRemoteWorkspaceNotification(target.id, 'workspace.changed', {
      snapshot: snapshot('/direct', 8),
      sourceClientId: 'client-c'
    })
    resolveRefresh?.(snapshot('/stale', 7))

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(send).toHaveBeenCalledWith(
      'remoteWorkspace:changed',
      expect.objectContaining({ snapshot: expect.objectContaining({ revision: 8 }) })
    )
    await vi.waitFor(() => expect(getCachedRemoteWorkspaceSnapshot(target.id)?.revision).toBe(8))
  })

  it('coalesces a newer revision that arrives while a refresh is in flight', async () => {
    let resolveFirst: ((value: RemoteWorkspaceSnapshot) => void) | undefined
    request
      .mockReturnValueOnce(
        new Promise<RemoteWorkspaceSnapshot>((resolve) => {
          resolveFirst = resolve
        })
      )
      .mockResolvedValueOnce(snapshot('/latest', 9))

    handleRemoteWorkspaceNotification(target.id, 'workspace.refreshRequired', {
      revision: 8,
      sourceClientId: 'client-b'
    })
    handleRemoteWorkspaceNotification(target.id, 'workspace.refreshRequired', {
      revision: 9,
      sourceClientId: 'client-b'
    })
    resolveFirst?.(snapshot('/stale', 8))

    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(send).toHaveBeenCalledWith(
      'remoteWorkspace:changed',
      expect.objectContaining({ snapshot: expect.objectContaining({ revision: 9 }) })
    )
  })

  it('stops a fallback refresh when the target is gone', async () => {
    getSshConnectionStoreMock.mockReturnValue({
      getTarget: () => undefined,
      listTargets: () => [target]
    })

    handleRemoteWorkspaceNotification(target.id, 'workspace.refreshRequired', {
      revision: 7,
      sourceClientId: 'client-b'
    })
    await Promise.resolve()

    expect(getActiveMultiplexerMock).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('logs a failed fallback refresh without publishing stale state', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    request.mockRejectedValue(new Error('connection lost'))

    handleRemoteWorkspaceNotification(target.id, 'workspace.refreshRequired', {
      revision: 7,
      sourceClientId: 'client-b'
    })

    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to refresh target-1 after revision 7: connection lost')
      )
    )
    expect(send).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
