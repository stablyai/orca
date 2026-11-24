import { describe, expect, it, vi } from 'vitest'
import { watchPluginWorkspaceStatus } from './plugin-workspace-status-watcher'

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
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
})
