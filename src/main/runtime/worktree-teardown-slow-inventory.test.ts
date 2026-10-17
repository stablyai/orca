import { beforeEach, describe, expect, it, vi } from 'vitest'

const { listRegisteredPtysMock } = vi.hoisted(() => ({
  listRegisteredPtysMock: vi.fn()
}))

vi.mock('../memory/pty-registry', () => ({
  listRegisteredPtys: listRegisteredPtysMock
}))

import {
  killAllProcessesForWorktree,
  WORKTREE_INVENTORY_BUDGET_MS,
  WORKTREE_PROCESS_SWEEP_TIMEOUT_MS
} from './worktree-teardown'
import type { IPtyProvider } from '../providers/types'
import { DaemonPtyAdapter } from '../daemon/daemon-pty-adapter'

describe('killAllProcessesForWorktree when a loaded daemon answers listSessions late (#23888)', () => {
  beforeEach(() => {
    listRegisteredPtysMock.mockReset()
  })

  const LOADED_LIST_REPLY_MS = WORKTREE_PROCESS_SWEEP_TIMEOUT_MS + 2_000

  // Models the real DaemonClient: a reply that takes longer than the request's own
  // timeout rejects with the client's timeout wording instead of arriving.
  function createLoadedDaemon(
    sessions: { sessionId: string; isAlive: boolean; cwd: string }[],
    listReplyMs: number,
    killReplies = true
  ): { adapter: IPtyProvider; killRequests: string[] } {
    const killRequests: string[] = []
    const fakeClient = {
      onDisconnected: () => () => {},
      onEvent: () => () => {},
      ensureConnected: async () => {},
      ensureConnectedWithin: async () => {},
      isConnected: () => true,
      hasObservedAuthenticatedDisconnect: () => false,
      getDaemonIdentity: () => null,
      disconnect: () => {},
      notify: () => {},
      request: (type: string, payload?: unknown, timeoutMs = 30_000): Promise<unknown> => {
        if (type === 'listSessions') {
          return new Promise((resolve, reject) => {
            if (listReplyMs > timeoutMs) {
              setTimeout(
                () => reject(new Error(`Request listSessions timed out after ${timeoutMs}ms`)),
                timeoutMs
              )
              return
            }
            setTimeout(() => resolve({ sessions }), listReplyMs)
          })
        }
        if (type === 'kill' && typeof payload === 'object' && payload && 'sessionId' in payload) {
          killRequests.push(String(payload.sessionId))
          if (!killReplies) {
            return new Promise((_resolve, reject) => {
              setTimeout(
                () => reject(new Error(`Request kill timed out after ${timeoutMs}ms`)),
                timeoutMs
              )
            })
          }
        }
        return Promise.resolve({})
      }
    }
    const adapter: IPtyProvider = new DaemonPtyAdapter({
      socketPath: '/tmp/sock',
      tokenPath: '/tmp/tok'
    })
    Reflect.set(adapter, 'client', fakeClient)
    return { adapter, killRequests }
  }

  it('removes a worktree with no live terminals instead of failing the sweep', async () => {
    vi.useFakeTimers()
    try {
      const { adapter } = createLoadedDaemon([], LOADED_LIST_REPLY_MS)
      listRegisteredPtysMock.mockReturnValue([])

      const outcome = killAllProcessesForWorktree('w1', {
        localProvider: adapter,
        requirePhysicalStop: true
      }).then(
        (result) => ({ result }),
        (error: Error) => ({ error })
      )
      await vi.advanceTimersByTimeAsync(LOADED_LIST_REPLY_MS)

      expect(await outcome).toEqual({
        result: { runtimeStopped: 0, providerStopped: 0, registryStopped: 0 }
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('still stops a live terminal the late inventory reports', async () => {
    vi.useFakeTimers()
    try {
      const sessionId = 'w1@@late0001'
      const { adapter, killRequests } = createLoadedDaemon(
        [{ sessionId, isAlive: true, cwd: '/tmp/w1' }],
        LOADED_LIST_REPLY_MS
      )
      listRegisteredPtysMock.mockReturnValue([])
      const onPtyStopped = vi.fn()

      const outcome = killAllProcessesForWorktree('w1', {
        localProvider: adapter,
        onPtyStopped,
        requirePhysicalStop: true
      }).then(
        (result) => ({ result }),
        (error: Error) => ({ error })
      )
      await vi.advanceTimersByTimeAsync(LOADED_LIST_REPLY_MS)

      expect(await outcome).toEqual({
        result: { runtimeStopped: 0, providerStopped: 1, registryStopped: 0 }
      })
      expect(killRequests).toEqual([sessionId])
      expect(onPtyStopped).toHaveBeenCalledWith(sessionId)
    } finally {
      vi.useRealTimers()
    }
  })

  // Why: the stop deadline gets the list's wait back only up to the inventory deadline, so a
  // stuck kill after a very late list still ends before the provider sweep's outer bound and
  // reports the stop failure, not the generic teardown timeout (#9500 wording).
  it('caps a stuck stop after a very late inventory at the inventory budget', async () => {
    vi.useFakeTimers()
    try {
      const sessionId = 'w1@@stuck0001'
      const veryLateListReplyMs = WORKTREE_INVENTORY_BUDGET_MS - 5_000
      const { adapter, killRequests } = createLoadedDaemon(
        [{ sessionId, isAlive: true, cwd: '/tmp/w1' }],
        veryLateListReplyMs,
        false
      )
      listRegisteredPtysMock.mockReturnValue([])

      const outcome = killAllProcessesForWorktree('w1', {
        localProvider: adapter,
        requirePhysicalStop: true
      }).then(
        () => {
          throw new Error('teardown unexpectedly resolved')
        },
        (error: Error) => error
      )
      await vi.advanceTimersByTimeAsync(
        WORKTREE_INVENTORY_BUDGET_MS + WORKTREE_PROCESS_SWEEP_TIMEOUT_MS
      )

      const error = await outcome
      expect(killRequests).toEqual([sessionId])
      expect(error.message).toContain('Failed to physically stop every PTY')
      expect(error.message).not.toContain('Timed out waiting for physical PTY teardown')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the inventory wait bounded when the daemon never answers', async () => {
    vi.useFakeTimers()
    try {
      const { adapter } = createLoadedDaemon([], Number.POSITIVE_INFINITY)
      listRegisteredPtysMock.mockReturnValue([])
      let settled = false

      const outcome = killAllProcessesForWorktree('w1', {
        localProvider: adapter,
        requirePhysicalStop: true
      }).then(
        () => {
          settled = true
          throw new Error('teardown unexpectedly resolved')
        },
        (error: Error) => {
          settled = true
          return error
        }
      )
      await vi.advanceTimersByTimeAsync(WORKTREE_INVENTORY_BUDGET_MS - 1_000)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1_000)

      const error = await outcome
      expect(error.message).toContain('Failed to physically stop every PTY')
      expect(error.message).toContain('listSessions timed out')
      expect(error.message).toContain('Retry with force delete')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not make an explicit Force Delete wait out the longer inventory budget', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { adapter } = createLoadedDaemon([], LOADED_LIST_REPLY_MS)
      listRegisteredPtysMock.mockReturnValue([])
      let settled = false

      const outcome = killAllProcessesForWorktree('w1', {
        localProvider: adapter,
        requirePhysicalStop: true,
        allowUnverifiedStop: true
      }).finally(() => {
        settled = true
      })
      await vi.advanceTimersByTimeAsync(WORKTREE_PROCESS_SWEEP_TIMEOUT_MS)

      expect(settled).toBe(true)
      await expect(outcome).resolves.toMatchObject({ providerStopped: 0 })
    } finally {
      warn.mockRestore()
      vi.useRealTimers()
    }
  })
})
