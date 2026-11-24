import { describe, expect, it, vi } from 'vitest'
import { watchPluginWorkspaceStatus } from './plugin-workspace-status-watcher'

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function psRow(state: 'working' | 'done' | 'inactive') {
  return {
    worktrees: [
      {
        worktreeId: 'wt-1',
        status: state,
        unread: false,
        liveTerminalCount: state === 'inactive' ? 0 : 1,
        hasHostSidebarActivity: state !== 'inactive',
        isActive: state !== 'inactive',
        isPinned: false,
        workspaceStatus: 'in-progress'
      }
    ]
  }
}

describe('watchPluginWorkspaceStatus', () => {
  it('serializes in-flight checks and runs one follow-up pass for triggers arriving mid-flight', async () => {
    vi.useFakeTimers()
    try {
      const calls: Deferred<ReturnType<typeof psRow>>[] = []
      const emitted: unknown[] = []
      let fireAgentStatus!: () => void

      const stop = watchPluginWorkspaceStatus({
        delegate: {
          callRuntime: () => {
            const d = deferred<ReturnType<typeof psRow>>()
            calls.push(d)
            return d.promise
          }
        },
        events: {
          wantsEvent: () => true,
          emitEvent: (_event, payload) => emitted.push(payload)
        },
        onAgentStatus: (listener) => {
          fireAgentStatus = listener
          return () => {}
        },
        onSessionWritten: () => () => {},
        onStateWritten: () => () => {},
        delayMs: 10
      })

      fireAgentStatus()
      await vi.advanceTimersByTimeAsync(10)
      expect(calls).toHaveLength(1)

      // Trigger again while the first worktree.ps call is still in flight.
      fireAgentStatus()
      await vi.advanceTimersByTimeAsync(50)
      expect(calls).toHaveLength(1)

      // Resolving the first call emits its state and schedules one follow-up pass.
      calls[0].resolve(psRow('working'))
      await vi.advanceTimersByTimeAsync(10)
      expect(calls).toHaveLength(2)
      expect(emitted).toHaveLength(1)
      expect(emitted[0]).toMatchObject({ workspaceId: 'wt-1', status: { state: 'working' } })

      calls[1].resolve(psRow('done'))
      await vi.advanceTimersByTimeAsync(0)
      expect(emitted).toHaveLength(2)
      expect(emitted[1]).toMatchObject({ workspaceId: 'wt-1', status: { state: 'done' } })

      stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not emit or reschedule when stopped while a check is in flight', async () => {
    vi.useFakeTimers()
    try {
      const calls: Deferred<ReturnType<typeof psRow>>[] = []
      const emitted: unknown[] = []
      let fireAgentStatus!: () => void

      const stop = watchPluginWorkspaceStatus({
        delegate: {
          callRuntime: () => {
            const d = deferred<ReturnType<typeof psRow>>()
            calls.push(d)
            return d.promise
          }
        },
        events: {
          wantsEvent: () => true,
          emitEvent: (_event, payload) => emitted.push(payload)
        },
        onAgentStatus: (listener) => {
          fireAgentStatus = listener
          return () => {}
        },
        onSessionWritten: () => () => {},
        onStateWritten: () => () => {},
        delayMs: 10
      })

      fireAgentStatus()
      await vi.advanceTimersByTimeAsync(10)
      expect(calls).toHaveLength(1)

      fireAgentStatus()
      stop()

      calls[0].resolve(psRow('working'))
      await vi.advanceTimersByTimeAsync(50)
      expect(emitted).toHaveLength(0)
      expect(calls).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries on transient failure and emits the transition once the retry succeeds', async () => {
    vi.useFakeTimers()
    try {
      const calls: Deferred<ReturnType<typeof psRow>>[] = []
      const emitted: unknown[] = []
      let fireAgentStatus!: () => void

      const stop = watchPluginWorkspaceStatus({
        delegate: {
          callRuntime: () => {
            const d = deferred<ReturnType<typeof psRow>>()
            calls.push(d)
            return d.promise
          }
        },
        events: {
          wantsEvent: () => true,
          emitEvent: (_event, payload) => emitted.push(payload)
        },
        onAgentStatus: (listener) => {
          fireAgentStatus = listener
          return () => {}
        },
        onSessionWritten: () => () => {},
        onStateWritten: () => () => {},
        delayMs: 10,
        retryDelayMs: 50
      })

      fireAgentStatus()
      await vi.advanceTimersByTimeAsync(10)
      expect(calls).toHaveLength(1)

      calls[0].reject(new Error('transient'))
      await vi.advanceTimersByTimeAsync(49)
      expect(calls).toHaveLength(1)
      expect(emitted).toHaveLength(0)

      await vi.advanceTimersByTimeAsync(1)
      expect(calls).toHaveLength(2)

      calls[1].resolve(psRow('done'))
      await vi.advanceTimersByTimeAsync(0)
      expect(emitted).toHaveLength(1)
      expect(emitted[0]).toMatchObject({ workspaceId: 'wt-1', status: { state: 'done' } })

      stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops retrying after reaching the retry limit', async () => {
    vi.useFakeTimers()
    try {
      const calls: Deferred<ReturnType<typeof psRow>>[] = []
      const emitted: unknown[] = []
      let fireAgentStatus!: () => void

      const stop = watchPluginWorkspaceStatus({
        delegate: {
          callRuntime: () => {
            const d = deferred<ReturnType<typeof psRow>>()
            calls.push(d)
            return d.promise
          }
        },
        events: {
          wantsEvent: () => true,
          emitEvent: (_event, payload) => emitted.push(payload)
        },
        onAgentStatus: (listener) => {
          fireAgentStatus = listener
          return () => {}
        },
        onSessionWritten: () => () => {},
        onStateWritten: () => () => {},
        delayMs: 10,
        retryDelayMs: 50
      })

      fireAgentStatus()
      await vi.advanceTimersByTimeAsync(10)
      expect(calls).toHaveLength(1)

      calls[0].reject(new Error('fail-1'))
      await vi.advanceTimersByTimeAsync(50)
      expect(calls).toHaveLength(2)

      calls[1].reject(new Error('fail-2'))
      await vi.advanceTimersByTimeAsync(50)
      expect(calls).toHaveLength(3)

      calls[2].reject(new Error('fail-3'))
      await vi.advanceTimersByTimeAsync(500)
      expect(calls).toHaveLength(3)
      expect(emitted).toHaveLength(0)

      stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels a pending retry when stopped', async () => {
    vi.useFakeTimers()
    try {
      const calls: Deferred<ReturnType<typeof psRow>>[] = []
      const emitted: unknown[] = []
      let fireAgentStatus!: () => void

      const stop = watchPluginWorkspaceStatus({
        delegate: {
          callRuntime: () => {
            const d = deferred<ReturnType<typeof psRow>>()
            calls.push(d)
            return d.promise
          }
        },
        events: {
          wantsEvent: () => true,
          emitEvent: (_event, payload) => emitted.push(payload)
        },
        onAgentStatus: (listener) => {
          fireAgentStatus = listener
          return () => {}
        },
        onSessionWritten: () => () => {},
        onStateWritten: () => () => {},
        delayMs: 10,
        retryDelayMs: 50
      })

      fireAgentStatus()
      await vi.advanceTimersByTimeAsync(10)
      expect(calls).toHaveLength(1)

      calls[0].reject(new Error('transient'))
      await vi.advanceTimersByTimeAsync(10)
      stop()

      await vi.advanceTimersByTimeAsync(200)
      expect(calls).toHaveLength(1)
      expect(emitted).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores listener arguments when debouncing session write triggers', async () => {
    vi.useFakeTimers()
    try {
      const calls: Deferred<ReturnType<typeof psRow>>[] = []
      let fireSessionWritten!: (...args: unknown[]) => void

      const stop = watchPluginWorkspaceStatus({
        delegate: {
          callRuntime: () => {
            const d = deferred<ReturnType<typeof psRow>>()
            calls.push(d)
            return d.promise
          }
        },
        events: {
          wantsEvent: () => true,
          emitEvent: () => {}
        },
        onAgentStatus: () => () => {},
        onSessionWritten: (listener) => {
          fireSessionWritten = listener
          return () => {}
        },
        onStateWritten: () => () => {},
        delayMs: 10
      })

      fireSessionWritten('local')
      await vi.advanceTimersByTimeAsync(9)
      expect(calls).toHaveLength(0)

      await vi.advanceTimersByTimeAsync(1)
      expect(calls).toHaveLength(1)

      stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
