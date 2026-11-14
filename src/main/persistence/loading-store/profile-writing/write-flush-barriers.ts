import { persistGithubCache } from '../github-cache/github-cache-persistence'

import type { StoreRuntimeState } from '../store-runtime-state'
import type { PrimaryStateWriteOperations } from './primary-state-writes'
import { enqueueWrite } from './primary-state-writes'
import { drainProfileStateOperations, runProfileStateFlush } from './profile-state-flush-lifetime'
import type { PendingProfileStateFlushOptions } from './profile-state-flush-lifetime'

type WriteFlushBarrierOperationsRuntime = Pick<
  StoreRuntimeState,
  | 'activeViewPreference'
  | 'automationListProjectionCache'
  | 'dataFile'
  | 'firstPendingSaveAt'
  | 'githubCacheDirty'
  | 'githubCachePersistedAt'
  | 'githubCacheLegacyFileHash'
  | 'githubCachePersistenceDisabled'
  | 'githubCachePersistTimer'
  | 'githubCacheRetryDelayMs'
  | 'lastDurableWriteGeneration'
  | 'pendingProfileFlushes'
  | 'pendingProfileMaintenance'
  | 'profileMaintenancePending'
  | 'profileStateAuthority'
  | 'workspaceSessionFieldCapture'
  | 'quitFlushPromise'
  | 'quitFlushStarted'
  | 'staleProfileStateTempCleanup'
  | 'state'
  | 'writeGeneration'
  | 'writeTimer'
  | 'writesFrozen'
>

const writeFlushBarrierOperationsContext = Symbol('WriteFlushBarrierOperations')
type WriteFlushBarrierOperationsContext = {
  runtime: WriteFlushBarrierOperationsRuntime
  writes: PrimaryStateWriteOperations
  bestEffortFinalFlush?: Promise<void>
}

export class WriteFlushBarrierOperations {
  readonly [writeFlushBarrierOperationsContext]: WriteFlushBarrierOperationsContext

  constructor(runtime: WriteFlushBarrierOperationsRuntime, writes: PrimaryStateWriteOperations) {
    this[writeFlushBarrierOperationsContext] = { runtime, writes }
  }

  flush(): void {
    const { runtime, writes } = this[writeFlushBarrierOperationsContext]
    runtime.automationListProjectionCache = null
    if (runtime.quitFlushStarted || runtime.profileMaintenancePending) {
      return
    }
    if (runtime.profileStateAuthority?.asynchronous) {
      runtime.writeGeneration++
      void flushCurrentStateAsync(this, { drainToStableGeneration: false }).catch((error) =>
        console.error('[persistence] Failed to flush state:', error)
      )
      return
    }
    try {
      writes.flushOrThrow()
    } catch (err) {
      console.error('[persistence] Failed to flush state:', err)
    }
    try {
      writes.flushActiveViewPreferenceOrThrow()
    } catch (err) {
      console.error('[active-view] Failed to flush preference:', err)
    }
    persistGithubCache(runtime, 'routine')
  }

  flushAsync(): Promise<void> {
    const context = this[writeFlushBarrierOperationsContext]
    context.bestEffortFinalFlush ??= this.flushFinalOrThrowAsync().catch((error) =>
      console.error('[persistence] Failed to flush final state:', error)
    )
    return context.bestEffortFinalFlush
  }

  flushFinalOrThrowAsync(): Promise<void> {
    const { runtime } = this[writeFlushBarrierOperationsContext]
    if (runtime.quitFlushPromise) {
      return runtime.quitFlushPromise
    }
    runtime.quitFlushStarted = true
    runtime.quitFlushPromise = Promise.resolve(runtime.pendingProfileMaintenance)
      .catch((error: unknown) => {
        // Failed maintenance may re-admit unchanged storage before this final checkpoint.
        if (runtime.profileMaintenancePending || runtime.writesFrozen) {
          throw error
        }
      })
      .then(async () => {
        if (runtime.profileMaintenancePending) {
          return
        }
        await drainProfileStateOperations([
          ...runtime.pendingProfileFlushes,
          runtime.staleProfileStateTempCleanup,
          runtime.profileStateAuthority?.drainBackups?.(true)
        ])
        await flushCurrentStateAsync(this, { final: true })
      })
      .finally(async () => {
        if (runtime.profileStateAuthority?.asynchronous) {
          runtime.writesFrozen = true
          runtime.workspaceSessionFieldCapture.clear()
          await runtime.profileStateAuthority.close()
        }
      })
    return runtime.quitFlushPromise
  }

  flushPendingAsync(): Promise<void> {
    const { runtime } = this[writeFlushBarrierOperationsContext]
    if (runtime.writesFrozen || runtime.quitFlushStarted || runtime.profileMaintenancePending) {
      return Promise.resolve()
    }
    // Best-effort callers must not livelock while the live app keeps mutating state.
    return flushCurrentStateAsync(this, { drainToStableGeneration: false }).catch(() => {})
  }

  flushPendingOrThrowAsync(options: PendingProfileStateFlushOptions = {}): Promise<void> {
    const { runtime } = this[writeFlushBarrierOperationsContext]
    if (runtime.writesFrozen || runtime.profileMaintenancePending || runtime.quitFlushStarted) {
      return Promise.reject(new Error('Cannot flush while persistence is finalized'))
    }
    return flushCurrentStateAsync(this, {
      signal: options.signal,
      drainToStableGeneration: options.drainToStableGeneration,
      fullCheckpoint: options.fullCheckpoint,
      requireInitialGenerationDurable: true
    })
  }
}

export async function flushCurrentStateAsync(
  owner: WriteFlushBarrierOperations,
  {
    final = false,
    signal,
    drainToStableGeneration = true,
    requireInitialGenerationDurable = false,
    fullCheckpoint = final
  }: {
    final?: boolean
    signal?: AbortSignal
    drainToStableGeneration?: boolean
    requireInitialGenerationDurable?: boolean
    fullCheckpoint?: boolean
  }
): Promise<void> {
  const { runtime, writes } = owner[writeFlushBarrierOperationsContext]
  return runProfileStateFlush(runtime, async () => {
    const requiredDurableGeneration = requireInitialGenerationDurable
      ? runtime.writeGeneration
      : null
    for (;;) {
      if (signal?.aborted) {
        throw new Error('Persistence flush aborted')
      }
      if (runtime.writeTimer) {
        clearTimeout(runtime.writeTimer)
        runtime.writeTimer = null
      }
      runtime.firstPendingSaveAt = null
      const generation = runtime.writeGeneration
      try {
        await enqueueWrite(writes, {
          fullCheckpoint,
          signal
        })
      } finally {
        await (final
          ? runtime.activeViewPreference.flushAsync()
          : runtime.activeViewPreference.flushPendingAsync(signal))
        // Quit and explicit barriers save the cache now; best-effort flushes may wait.
        persistGithubCache(
          runtime,
          final || requireInitialGenerationDurable ? 'barrier' : 'routine'
        )
        if (final || runtime.profileMaintenancePending) {
          await runtime.profileStateAuthority?.drainBackups?.(true)
        }
      }
      if (signal?.aborted) {
        throw new Error('Persistence flush aborted')
      }
      if (!drainToStableGeneration) {
        if (
          requiredDurableGeneration === null ||
          runtime.lastDurableWriteGeneration >= requiredDurableGeneration
        ) {
          break
        }
        continue
      }
      if (generation === runtime.writeGeneration) {
        break
      }
    }
  })
}
