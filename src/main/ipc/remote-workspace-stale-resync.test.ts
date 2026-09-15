import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import {
  REMOTE_WORKSPACE_STALE_NOTIFICATION,
  type RemoteWorkspaceChangedEvent,
  type RemoteWorkspaceSession
} from '../../shared/remote-workspace-types'

const { getActiveMultiplexerMock, getSshConnectionStoreMock } = vi.hoisted(() => ({
  getActiveMultiplexerMock: vi.fn(),
  getSshConnectionStoreMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() }
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

function session(activeTabId: string): RemoteWorkspaceSession {
  return {
    activeWorktreePath: '/remote/worktree',
    activeTabId,
    tabsByWorktreePath: {
      '/remote/worktree': [{ id: activeTabId, worktreePath: '/remote/worktree' } as never]
    },
    terminalLayoutsByTabId: {}
  }
}

describe('workspace.stale resync', () => {
  const sent: RemoteWorkspaceChangedEvent[] = []
  const request = vi.fn()
  const store = { getRepo: vi.fn(), getWorkspaceSession: vi.fn() } as unknown as Store

  beforeEach(() => {
    sent.length = 0
    request.mockReset()
    _resetRemoteWorkspaceCachesForTests()
    getActiveMultiplexerMock.mockReset()
    getActiveMultiplexerMock.mockImplementation(() => ({ request }))
    getSshConnectionStoreMock.mockReset()
    getSshConnectionStoreMock.mockImplementation(() => ({
      getTarget: (id: string) => ({ id, host: 'example.test', username: 'dev' }),
      listTargets: () => []
    }))
    const win = {
      isDestroyed: () => false,
      webContents: {
        send: (_channel: string, event: RemoteWorkspaceChangedEvent) => sent.push(event)
      }
    }
    registerRemoteWorkspaceHandlers(store, () => win as never)
  })

  it('re-reads the snapshot through workspace.get and publishes it to the renderer', async () => {
    request.mockResolvedValue({
      namespace: 'target-1',
      revision: 12,
      updatedAt: 5,
      schemaVersion: 1,
      session: session('tab-from-other-device')
    })

    handleRemoteWorkspaceNotification('target-1', REMOTE_WORKSPACE_STALE_NOTIFICATION, {
      namespace: 'target-1'
    })
    await vi.waitFor(() => expect(sent).toHaveLength(1))

    expect(request).toHaveBeenCalledWith('workspace.get', { namespace: expect.any(String) })
    expect(sent[0].targetId).toBe('target-1')
    expect(sent[0].snapshot.revision).toBe(12)
    expect(sent[0].snapshot.session.activeTabId).toBe('tab-from-other-device')
    // The marker names no author, so the renderer's own-echo filter must not discard the resync.
    expect(sent[0].sourceClientId).toBeUndefined()
  })

  it('collapses a burst of markers into one extra read rather than one read per marker', async () => {
    const released: ((value: unknown) => void)[] = []
    request.mockImplementation(
      () =>
        new Promise((resolve) => {
          released.push(resolve)
        })
    )

    for (let i = 0; i < 4; i++) {
      handleRemoteWorkspaceNotification('target-1', REMOTE_WORKSPACE_STALE_NOTIFICATION, {
        namespace: 'target-1'
      })
    }
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))

    request.mockResolvedValue({
      namespace: 'target-1',
      revision: 3,
      updatedAt: 1,
      schemaVersion: 1,
      session: session('tab-a')
    })
    released[0]?.({
      namespace: 'target-1',
      revision: 2,
      updatedAt: 1,
      schemaVersion: 1,
      session: session('tab-a')
    })

    // Exactly one follow-up read for the markers that landed mid-flight: never zero, never four.
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2))
    await Promise.resolve()
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('stays silent when the re-read finds the session it already had', async () => {
    request.mockResolvedValue({
      namespace: 'target-1',
      revision: 4,
      updatedAt: 1,
      schemaVersion: 1,
      session: session('tab-a')
    })

    handleRemoteWorkspaceNotification('target-1', REMOTE_WORKSPACE_STALE_NOTIFICATION, {
      namespace: 'target-1'
    })
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(sent).toHaveLength(1))

    handleRemoteWorkspaceNotification('target-1', REMOTE_WORKSPACE_STALE_NOTIFICATION, {
      namespace: 'target-1'
    })
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2))
    await Promise.resolve()
    expect(sent).toHaveLength(1)
  })
})
