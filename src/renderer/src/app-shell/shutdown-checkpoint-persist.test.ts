import { describe, expect, it, vi } from 'vitest'
import {
  createShutdownCheckpointPersist,
  type ShutdownCheckpointPersistDeps
} from './shutdown-checkpoint-persist'

function makeDeps(
  overrides: Partial<ShutdownCheckpointPersistDeps> = {}
): ShutdownCheckpointPersistDeps {
  return {
    shouldCaptureSession: () => true,
    captureTerminalBuffers: vi.fn(),
    captureSleepingAgentSessions: vi.fn(),
    buildSessionSnapshots: () => [{ state: { activeTabId: 't1' } }] as never,
    buildUiPatch: () => ({ activeView: 'workspace' }) as never,
    hasDirtyOpenFiles: () => false,
    isDegradableShutdownInProgress: () => true,
    stageBeforeUnloadSync: vi.fn(),
    ...overrides
  }
}

describe('createShutdownCheckpointPersist', () => {
  it('does not fail the checkpoint when the sleeping-agent quit capture throws (STA-5505)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const deps = makeDeps({
      captureSleepingAgentSessions: () => {
        throw new Error('capture exploded')
      }
    })

    expect(createShutdownCheckpointPersist(deps).run).not.toThrow()
    // The full snapshot must still be staged — a weaker resume record for done
    // panes is strictly better than blocking the update.
    expect(deps.stageBeforeUnloadSync).toHaveBeenCalledWith({
      sessions: [{ state: { activeTabId: 't1' } }],
      ui: { activeView: 'workspace' }
    })
    vi.restoreAllMocks()
  })

  it('keeps sleeping-capture diagnostics non-throwing for unstringifiable values', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const deps = makeDeps({
      captureSleepingAgentSessions: () => {
        throw Object.create(null)
      }
    })

    expect(createShutdownCheckpointPersist(deps).run).not.toThrow()
    expect(deps.stageBeforeUnloadSync).toHaveBeenCalledTimes(1)
    vi.restoreAllMocks()
  })

  it('keeps the first full-staging failure a visible, retryable error (STA-5505)', () => {
    const stageBeforeUnloadSync = vi.fn(() => {
      throw new Error('sync IPC staging failed')
    })
    const { run: persist } = createShutdownCheckpointPersist(makeDeps({ stageBeforeUnloadSync }))

    // A transient failure must not silently cost the full snapshot on attempt one.
    expect(persist).toThrow('sync IPC staging failed')
    expect(stageBeforeUnloadSync).toHaveBeenCalledTimes(1)
  })

  it('degrades to durable-only staging when full staging fails again on retry (STA-5505)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const stageBeforeUnloadSync = vi.fn((args: { sessions: unknown[] }) => {
      if (args.sessions.length > 0) {
        throw new Error('sync IPC staging failed')
      }
    })
    const { run: persist } = createShutdownCheckpointPersist(makeDeps({ stageBeforeUnloadSync }))

    expect(persist).toThrow('sync IPC staging failed')
    expect(persist).not.toThrow()
    expect(stageBeforeUnloadSync).toHaveBeenCalledTimes(3)
    expect(stageBeforeUnloadSync).toHaveBeenLastCalledWith({
      sessions: [],
      ui: { activeView: 'workspace' }
    })
    vi.restoreAllMocks()
  })

  it('stages the full snapshot when a retry after a transient staging failure succeeds', () => {
    let calls = 0
    const stageBeforeUnloadSync = vi.fn(() => {
      calls += 1
      if (calls === 1) {
        throw new Error('transient staging failure')
      }
    })
    const { run: persist } = createShutdownCheckpointPersist(makeDeps({ stageBeforeUnloadSync }))

    expect(persist).toThrow('transient staging failure')
    expect(persist).not.toThrow()
    expect(stageBeforeUnloadSync).toHaveBeenLastCalledWith({
      sessions: [{ state: { activeTabId: 't1' } }],
      ui: { activeView: 'workspace' }
    })
  })

  it('still fails the checkpoint when staging throws and dirty editor buffers exist', () => {
    const deps = makeDeps({
      hasDirtyOpenFiles: () => true,
      stageBeforeUnloadSync: vi.fn(() => {
        throw new Error('sync IPC staging failed')
      })
    })
    const { run: persist } = createShutdownCheckpointPersist(deps)

    expect(persist).toThrow('sync IPC staging failed')
    expect(persist).toThrow('sync IPC staging failed')
  })

  it('still fails the checkpoint when staging throws outside a degradable shutdown', () => {
    const deps = makeDeps({
      isDegradableShutdownInProgress: () => false,
      stageBeforeUnloadSync: vi.fn(() => {
        throw new Error('sync IPC staging failed')
      })
    })
    const { run: persist } = createShutdownCheckpointPersist(deps)

    expect(persist).toThrow('sync IPC staging failed')
    expect(persist).toThrow('sync IPC staging failed')
  })

  it('fails the checkpoint when even durable-only staging throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const deps = makeDeps({
      buildSessionSnapshots: () => {
        throw new Error('snapshot build failed')
      },
      stageBeforeUnloadSync: vi.fn(() => {
        throw new Error('durable staging failed')
      })
    })

    expect(createShutdownCheckpointPersist(deps).run).toThrow('durable staging failed')
    vi.restoreAllMocks()
  })

  it('keeps the durable-session fallback for snapshot build failures', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const deps = makeDeps({
      buildSessionSnapshots: () => {
        throw new Error('snapshot build failed')
      }
    })

    expect(createShutdownCheckpointPersist(deps).run).not.toThrow()
    expect(deps.stageBeforeUnloadSync).toHaveBeenCalledTimes(1)
    expect(deps.stageBeforeUnloadSync).toHaveBeenCalledWith({
      sessions: [],
      ui: { activeView: 'workspace' }
    })
    vi.restoreAllMocks()
  })

  it('rethrows snapshot build failures when dirty editor buffers exist', () => {
    const deps = makeDeps({
      hasDirtyOpenFiles: () => true,
      buildSessionSnapshots: () => {
        throw new Error('snapshot build failed')
      }
    })

    expect(createShutdownCheckpointPersist(deps).run).toThrow('snapshot build failed')
    expect(deps.stageBeforeUnloadSync).not.toHaveBeenCalled()
  })

  it('skips capture and stages empty sessions before hydration completes', () => {
    const deps = makeDeps({ shouldCaptureSession: () => false })

    createShutdownCheckpointPersist(deps).run()

    expect(deps.captureTerminalBuffers).not.toHaveBeenCalled()
    expect(deps.captureSleepingAgentSessions).not.toHaveBeenCalled()
    expect(deps.stageBeforeUnloadSync).toHaveBeenCalledWith({
      sessions: [],
      ui: { activeView: 'workspace' }
    })
  })

  it('forgets a failed attempt when an aborted shutdown resets the lifecycle', () => {
    const stageBeforeUnloadSync = vi.fn(() => {
      throw new Error('sync IPC staging failed')
    })
    const persist = createShutdownCheckpointPersist(makeDeps({ stageBeforeUnloadSync }))

    expect(persist.run).toThrow('sync IPC staging failed')
    persist.abandonAttempt()
    expect(persist.run).toThrow('sync IPC staging failed')
    expect(stageBeforeUnloadSync).toHaveBeenCalledTimes(2)
  })
})
