import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { encodeJsonRpcFrame } from '../ssh/relay-protocol'
import {
  REMOTE_WORKSPACE_STALE_NOTIFICATION,
  REMOTE_WORKSPACE_CHANGED_NOTIFICATION,
  type RemoteWorkspaceChangedEvent,
  type RemoteWorkspaceSession,
  type RemoteWorkspaceSnapshot
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
import {
  getCachedRemoteWorkspaceSnapshot,
  rememberLocallyPatchedRemoteWorkspaceSnapshot,
  rememberRemoteWorkspaceSnapshot
} from './remote-workspace-snapshot-cache'
import { isRemoteWorkspaceResyncInFlight } from './remote-workspace-stale-resync'
import { CLIENT_ID } from './remote-workspace-client-identity'

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

function snapshot(revision: number, tabId: string): RemoteWorkspaceSnapshot {
  return {
    namespace: 'target-1',
    revision,
    updatedAt: revision,
    schemaVersion: 1,
    session: session(tabId)
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
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the window fake exposes only the webContents.send the handlers call.
    registerRemoteWorkspaceHandlers(store, () => win as never, {
      readMachineName: () => 'Build server'
    })
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

  it.each(['own', 'peer'] as const)(
    'checks a %s snapshot against the own patch reply received during its pending read',
    async (source) => {
      rememberRemoteWorkspaceSnapshot('target-1', snapshot(1, 'tab-before-patch'))
      const ownSnapshot = snapshot(2, 'tab-from-own-patch')
      const readSnapshot = source === 'own' ? ownSnapshot : snapshot(3, 'tab-from-peer')
      request.mockResolvedValue(readSnapshot)
      let releaseRead: ((value: RemoteWorkspaceSnapshot) => void) | undefined
      request.mockImplementationOnce(
        () =>
          new Promise<RemoteWorkspaceSnapshot>((resolve) => {
            releaseRead = resolve
          })
      )

      handleRemoteWorkspaceNotification('target-1', REMOTE_WORKSPACE_STALE_NOTIFICATION, {
        namespace: 'target-1'
      })
      expect(request).toHaveBeenCalledTimes(1)
      expect(isRemoteWorkspaceResyncInFlight('target-1')).toBe(true)

      // The relay publishes the stale marker before returning this client's patch reply.
      rememberLocallyPatchedRemoteWorkspaceSnapshot('target-1', ownSnapshot)
      releaseRead?.(readSnapshot)
      await vi.waitFor(() => expect(isRemoteWorkspaceResyncInFlight('target-1')).toBe(false))

      expect(sent.map((event) => event.snapshot.session.activeTabId)).toEqual(
        source === 'own' ? [] : ['tab-from-peer']
      )
    }
  )

  it('delivers a peer snapshot cached by a stale-revision patch reply during the read', async () => {
    rememberRemoteWorkspaceSnapshot('target-1', snapshot(1, 'tab-before-peer'))
    const peerSnapshot = snapshot(2, 'tab-from-peer')
    let releaseRead: ((value: RemoteWorkspaceSnapshot) => void) | undefined
    request.mockImplementationOnce(
      () =>
        new Promise<RemoteWorkspaceSnapshot>((resolve) => {
          releaseRead = resolve
        })
    )

    handleRemoteWorkspaceNotification('target-1', REMOTE_WORKSPACE_STALE_NOTIFICATION, {
      namespace: 'target-1'
    })
    // A rejected local patch caches the peer snapshot, but the renderer only records a conflict.
    rememberRemoteWorkspaceSnapshot('target-1', peerSnapshot)
    releaseRead?.(peerSnapshot)
    await vi.waitFor(() => expect(isRemoteWorkspaceResyncInFlight('target-1')).toBe(false))

    expect(sent.map((event) => event.snapshot.session.activeTabId)).toEqual(['tab-from-peer'])
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('suppresses an own reply already acknowledged before the marker', async () => {
    const ownSnapshot = snapshot(2, 'tab-from-own-patch')
    rememberLocallyPatchedRemoteWorkspaceSnapshot('target-1', ownSnapshot)
    request.mockResolvedValue(ownSnapshot)

    handleRemoteWorkspaceNotification('target-1', REMOTE_WORKSPACE_STALE_NOTIFICATION, {
      namespace: 'target-1'
    })
    await vi.waitFor(() => expect(isRemoteWorkspaceResyncInFlight('target-1')).toBe(false))

    expect(sent).toEqual([])
  })

  it('still reads a queued peer change after suppressing the own echo', async () => {
    const ownSnapshot = snapshot(2, 'tab-from-own-patch')
    let releaseRead: ((value: RemoteWorkspaceSnapshot) => void) | undefined
    request.mockImplementationOnce(
      () =>
        new Promise<RemoteWorkspaceSnapshot>((resolve) => {
          releaseRead = resolve
        })
    )
    request.mockResolvedValue(snapshot(3, 'tab-from-peer'))

    for (let index = 0; index < 2; index += 1) {
      handleRemoteWorkspaceNotification('target-1', REMOTE_WORKSPACE_STALE_NOTIFICATION, {
        namespace: 'target-1'
      })
    }

    rememberLocallyPatchedRemoteWorkspaceSnapshot('target-1', ownSnapshot)
    releaseRead?.(ownSnapshot)
    await vi.waitFor(() => expect(isRemoteWorkspaceResyncInFlight('target-1')).toBe(false))

    expect(request).toHaveBeenCalledTimes(2)
    expect(sent.map((event) => event.snapshot.session.activeTabId)).toEqual(['tab-from-peer'])
  })

  it('keeps an own acknowledgement from suppressing another target', async () => {
    const releases: ((value: RemoteWorkspaceSnapshot) => void)[] = []
    request.mockImplementation(
      () => new Promise<RemoteWorkspaceSnapshot>((resolve) => releases.push(resolve))
    )
    for (const targetId of ['target-1', 'target-2']) {
      handleRemoteWorkspaceNotification(targetId, REMOTE_WORKSPACE_STALE_NOTIFICATION, {
        namespace: 'target-1'
      })
    }
    const ownSnapshot = snapshot(2, 'same-tab')
    rememberLocallyPatchedRemoteWorkspaceSnapshot('target-1', ownSnapshot)
    releases[0]?.(ownSnapshot)
    releases[1]?.(ownSnapshot)
    await vi.waitFor(() => {
      expect(isRemoteWorkspaceResyncInFlight('target-1')).toBe(false)
      expect(isRemoteWorkspaceResyncInFlight('target-2')).toBe(false)
    })

    expect(sent.map((event) => event.targetId)).toEqual(['target-2'])
  })

  it('does not deliver a captured read after a same-token own acknowledgement advances the cache', async () => {
    rememberRemoteWorkspaceSnapshot('target-1', snapshot(1, 'initial-tab'))
    request.mockResolvedValue(snapshot(3, 'newer-own-tab'))
    let releaseRead: ((value: RemoteWorkspaceSnapshot) => void) | undefined
    request.mockImplementationOnce(
      () =>
        new Promise<RemoteWorkspaceSnapshot>((resolve) => {
          releaseRead = resolve
        })
    )
    handleRemoteWorkspaceNotification('target-1', REMOTE_WORKSPACE_STALE_NOTIFICATION, {
      namespace: 'target-1'
    })

    releaseRead?.(snapshot(2, 'peer-tab'))
    queueMicrotask(() => {
      rememberLocallyPatchedRemoteWorkspaceSnapshot('target-1', snapshot(3, 'newer-own-tab'))
    })
    await vi.waitFor(() => expect(isRemoteWorkspaceResyncInFlight('target-1')).toBe(false))

    expect(getCachedRemoteWorkspaceSnapshot('target-1')?.revision).toBe(3)
    expect(sent.map((event) => event.snapshot.revision)).toEqual([])
    expect(request).toHaveBeenCalledTimes(2)
  })

  it.each([
    { source: 'peer', order: 'response-first' },
    { source: 'peer', order: 'notification-first' },
    { source: 'own', order: 'response-first' },
    { source: 'own', order: 'notification-first' }
  ])(
    'never publishes an older read after a newer $source notification ($order)',
    async ({ source, order }) => {
      let receive: ((data: Buffer) => void) | undefined
      const mux = new SshChannelMultiplexer({
        write: () => {},
        onData: (callback) => {
          receive = callback
        },
        onClose: () => {}
      })
      const read = vi.spyOn(mux, 'request')
      getActiveMultiplexerMock.mockReturnValue(mux)
      mux.onNotification((method, params) =>
        handleRemoteWorkspaceNotification('target-1', method, params)
      )
      const initial = rememberRemoteWorkspaceSnapshot('target-1', snapshot(2, 'initial-tab'))
      const sourceClientId = source === 'own' ? CLIENT_ID : 'peer-client'
      try {
        handleRemoteWorkspaceNotification('target-1', REMOTE_WORKSPACE_STALE_NOTIFICATION, {
          namespace: 'target-1'
        })
        const reply = { jsonrpc: '2.0', id: 1, result: snapshot(2, 'older-read') } as const
        const changed = {
          jsonrpc: '2.0',
          method: REMOTE_WORKSPACE_CHANGED_NOTIFICATION,
          params: { snapshot: snapshot(3, 'newer-source'), sourceClientId }
        } as const
        const messages = order === 'response-first' ? [reply, changed] : [changed, reply]
        receive?.(
          Buffer.concat(messages.map((message, index) => encodeJsonRpcFrame(message, index + 1, 0)))
        )
        if (source === 'own') {
          expect(getCachedRemoteWorkspaceSnapshot('target-1')?.hostObservationToken).toBe(
            initial.hostObservationToken
          )
        }
        await new Promise((resolve) => setImmediate(resolve))
        expect(getCachedRemoteWorkspaceSnapshot('target-1')?.revision).toBe(3)
        expect(sent.map((event) => event.snapshot.revision)).toEqual([3])
        await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2))
        receive?.(
          encodeJsonRpcFrame({ jsonrpc: '2.0', id: 2, result: snapshot(3, 'newer-source') }, 3, 0)
        )
        await vi.waitFor(() => expect(isRemoteWorkspaceResyncInFlight('target-1')).toBe(false))
        expect(sent.map((event) => event.snapshot.revision)).toEqual([3])
        expect(sent[0].sourceClientId).toBe(sourceClientId)
      } finally {
        mux.dispose()
      }
    }
  )

  it.each([2, 3])(
    'does not deliver a captured read after peer revision %i replaces it',
    async (peerRevision) => {
      rememberRemoteWorkspaceSnapshot('target-1', snapshot(1, 'initial-tab'))
      const peer = snapshot(peerRevision, 'newer-peer')
      request.mockResolvedValue(peer)
      let releaseRead: ((value: RemoteWorkspaceSnapshot) => void) | undefined
      request.mockImplementationOnce(
        () =>
          new Promise<RemoteWorkspaceSnapshot>((resolve) => {
            releaseRead = resolve
          })
      )
      handleRemoteWorkspaceNotification('target-1', REMOTE_WORKSPACE_STALE_NOTIFICATION, {
        namespace: 'target-1'
      })

      releaseRead?.(snapshot(2, 'older-read'))
      queueMicrotask(() => {
        handleRemoteWorkspaceNotification('target-1', REMOTE_WORKSPACE_CHANGED_NOTIFICATION, {
          snapshot: peer,
          sourceClientId: 'peer-client'
        })
      })
      await vi.waitFor(() => expect(isRemoteWorkspaceResyncInFlight('target-1')).toBe(false))

      expect(getCachedRemoteWorkspaceSnapshot('target-1')?.session.activeTabId).toBe('newer-peer')
      expect(sent.map((event) => event.snapshot.session.activeTabId)).toEqual(['newer-peer'])
      expect(request).toHaveBeenCalledTimes(2)
    }
  )

  it('accepts a relay reset after rereading a response that raced a host change', async () => {
    rememberRemoteWorkspaceSnapshot('target-1', snapshot(40, 'before-reset'))
    request.mockResolvedValue(snapshot(1, 'after-reset'))
    let releaseRead: ((value: RemoteWorkspaceSnapshot) => void) | undefined
    request.mockImplementationOnce(
      () =>
        new Promise<RemoteWorkspaceSnapshot>((resolve) => {
          releaseRead = resolve
        })
    )
    handleRemoteWorkspaceNotification('target-1', REMOTE_WORKSPACE_STALE_NOTIFICATION, {
      namespace: 'target-1'
    })
    handleRemoteWorkspaceNotification('target-1', REMOTE_WORKSPACE_CHANGED_NOTIFICATION, {
      snapshot: snapshot(41, 'last-before-reset'),
      sourceClientId: 'peer-client'
    })
    releaseRead?.(snapshot(1, 'after-reset'))
    await vi.waitFor(() => expect(isRemoteWorkspaceResyncInFlight('target-1')).toBe(false))

    expect(getCachedRemoteWorkspaceSnapshot('target-1')?.revision).toBe(1)
    expect(sent.map((event) => event.snapshot.revision)).toEqual([41, 1])
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('still accepts a lower revision after a relay reset', async () => {
    rememberRemoteWorkspaceSnapshot('target-1', snapshot(40, 'before-reset'))
    request.mockResolvedValue(snapshot(1, 'after-reset'))
    handleRemoteWorkspaceNotification('target-1', REMOTE_WORKSPACE_STALE_NOTIFICATION, {
      namespace: 'target-1'
    })
    await vi.waitFor(() => expect(isRemoteWorkspaceResyncInFlight('target-1')).toBe(false))
    expect(getCachedRemoteWorkspaceSnapshot('target-1')?.revision).toBe(1)
    expect(sent.map((event) => event.snapshot.session.activeTabId)).toEqual(['after-reset'])
    expect(request).toHaveBeenCalledTimes(1)
  })
})
