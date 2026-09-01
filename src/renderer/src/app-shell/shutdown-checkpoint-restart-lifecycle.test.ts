// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ORCA_APP_RESTART_ABORTED_EVENT,
  ORCA_APP_RESTART_STARTED_EVENT,
  ORCA_UPDATER_QUIT_AND_INSTALL_ABORTED_EVENT,
  ORCA_UPDATER_QUIT_AND_INSTALL_STARTED_EVENT
} from '../../../shared/updater-renderer-events'
import {
  ORCA_RENDERER_SHUTDOWN_CHECKPOINT_ABORTED_EVENT,
  ORCA_RENDERER_UNLOAD_PREVENTED_EVENT
} from '../../../shared/renderer-shutdown-events'
import { prepareRendererForAppRestart } from '../../../shared/renderer-restart-preparation'
import {
  createShutdownCheckpointBeforeUnloadHandler,
  createShutdownCheckpointGuard
} from '../lib/shutdown-checkpoint-guard'
import {
  isIntentionalAppRestartInProgress,
  registerUpdaterBeforeUnloadBypass
} from '../lib/updater-beforeunload'
import {
  createShutdownCheckpointPersist,
  type ShutdownCheckpointPersistDeps
} from './shutdown-checkpoint-persist'

type LifecycleHarness = {
  cleanup: () => void
  prepare: () => Promise<void>
  stageBeforeUnloadSync: ReturnType<typeof vi.fn>
}

type LifecycleHarnessOverrides = Partial<
  Pick<ShutdownCheckpointPersistDeps, 'buildSessionSnapshots' | 'hasDirtyOpenFiles'>
>

function createLifecycleHarness(
  startedEventName: string,
  abortedEventName: string,
  overrides: LifecycleHarnessOverrides = {}
): LifecycleHarness {
  const stageBeforeUnloadSync = vi.fn((args: { sessions: unknown[] }) => {
    if (args.sessions.length > 0) {
      throw new Error('deterministic full-stage failure')
    }
  })
  const persist = createShutdownCheckpointPersist({
    shouldCaptureSession: () => true,
    captureTerminalBuffers: vi.fn(),
    captureSleepingAgentSessions: vi.fn(),
    buildSessionSnapshots: () => [{ state: { activeTabId: 't1' } }] as never,
    buildUiPatch: () => ({ activeView: 'workspace' }) as never,
    hasDirtyOpenFiles: () => false,
    isDegradableShutdownInProgress: isIntentionalAppRestartInProgress,
    stageBeforeUnloadSync,
    ...overrides
  })
  const guard = createShutdownCheckpointGuard(persist.run, persist.abandonAttempt)
  const checkpoint = createShutdownCheckpointBeforeUnloadHandler(guard)
  const cleanupRestartTracking = registerUpdaterBeforeUnloadBypass()
  window.addEventListener('beforeunload', checkpoint)
  window.addEventListener(
    ORCA_RENDERER_SHUTDOWN_CHECKPOINT_ABORTED_EVENT,
    guard.abortAfterCheckpointFailure
  )
  window.addEventListener(abortedEventName, guard.abandonAttempt)
  window.addEventListener(ORCA_RENDERER_UNLOAD_PREVENTED_EVENT, guard.abandonAttempt)
  return {
    stageBeforeUnloadSync,
    prepare: () =>
      prepareRendererForAppRestart(window, {
        startedEventName,
        abortedEventName,
        awaitCheckpoint: () => Promise.resolve()
      }),
    cleanup: () => {
      cleanupRestartTracking()
      window.removeEventListener('beforeunload', checkpoint)
      window.removeEventListener(
        ORCA_RENDERER_SHUTDOWN_CHECKPOINT_ABORTED_EVENT,
        guard.abortAfterCheckpointFailure
      )
      window.removeEventListener(abortedEventName, guard.abandonAttempt)
      window.removeEventListener(ORCA_RENDERER_UNLOAD_PREVENTED_EVENT, guard.abandonAttempt)
    }
  }
}

describe('shutdown checkpoint restart lifecycle', () => {
  const cleanupFns: (() => void)[] = []

  afterEach(() => {
    cleanupFns.splice(0).forEach((cleanup) => cleanup())
    vi.restoreAllMocks()
  })

  it.each([
    {
      lifecycle: 'app restart',
      startedEventName: ORCA_APP_RESTART_STARTED_EVENT,
      abortedEventName: ORCA_APP_RESTART_ABORTED_EVENT
    },
    {
      lifecycle: 'updater install',
      startedEventName: ORCA_UPDATER_QUIT_AND_INSTALL_STARTED_EVENT,
      abortedEventName: ORCA_UPDATER_QUIT_AND_INSTALL_ABORTED_EVENT
    }
  ])(
    'preserves retry-then-degrade across a checkpoint-caused $lifecycle abort',
    async ({ startedEventName, abortedEventName }) => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const harness = createLifecycleHarness(startedEventName, abortedEventName)
      cleanupFns.push(harness.cleanup)

      await expect(harness.prepare()).rejects.toThrow('deterministic full-stage failure')
      expect(isIntentionalAppRestartInProgress()).toBe(false)
      await expect(harness.prepare()).resolves.toBeUndefined()

      expect(harness.stageBeforeUnloadSync).toHaveBeenCalledTimes(3)
      expect(harness.stageBeforeUnloadSync).toHaveBeenLastCalledWith({
        sessions: [],
        ui: { activeView: 'workspace' }
      })
    }
  )

  it('abandons retry state when a later restart attempt is independently canceled', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const harness = createLifecycleHarness(
      ORCA_APP_RESTART_STARTED_EVENT,
      ORCA_APP_RESTART_ABORTED_EVENT
    )
    cleanupFns.push(harness.cleanup)

    await expect(harness.prepare()).rejects.toThrow('deterministic full-stage failure')
    window.dispatchEvent(new Event(ORCA_APP_RESTART_STARTED_EVENT))
    window.dispatchEvent(new Event(ORCA_APP_RESTART_ABORTED_EVENT))
    await expect(harness.prepare()).rejects.toThrow('deterministic full-stage failure')

    expect(harness.stageBeforeUnloadSync).toHaveBeenCalledTimes(2)
  })

  // Mirrors the e2e fixture in tests/e2e/update-install-renderer-checkpoint-recovery.spec.ts,
  // which asserted the pre-STA-5505 bare message long after the cause suffix landed (STA-5668).
  it('names the snapshot-build cause when dirty drafts block the checkpoint', async () => {
    const snapshotFailure = "Cannot read properties of null (reading 'toLowerCase')"
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const harness = createLifecycleHarness(
      ORCA_UPDATER_QUIT_AND_INSTALL_STARTED_EVENT,
      ORCA_UPDATER_QUIT_AND_INSTALL_ABORTED_EVENT,
      {
        buildSessionSnapshots: () => {
          throw new Error(snapshotFailure)
        },
        hasDirtyOpenFiles: () => true
      }
    )
    cleanupFns.push(harness.cleanup)

    await expect(harness.prepare()).rejects.toThrow(
      new Error(`Renderer shutdown checkpoint was not completed: ${snapshotFailure}`)
    )
    // Dirty drafts must block before any durable-only degrade stages over them.
    expect(harness.stageBeforeUnloadSync).not.toHaveBeenCalled()
  })
})
