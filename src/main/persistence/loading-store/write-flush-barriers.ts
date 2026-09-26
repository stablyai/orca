import { writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { rename, rm, writeFile } from 'node:fs/promises'
import { durableWriteTempPath } from '../../durable-file-write'
import { getGithubCacheFile } from './user-data-path'

import type { StoreRuntimeState } from './store-runtime-state'
import type { PrimaryStateWriteOperations } from './primary-state-writes'
import { enqueueWrite } from './primary-state-writes'
import { drainProfileStateOperations, runProfileStateFlush } from './profile-state-flush-lifetime'

type WriteFlushBarrierOperationsRuntime = Pick<
  StoreRuntimeState,
  | 'activeViewPreference'
  | 'automationListProjectionCache'
  | 'dataFile'
  | 'firstPendingSaveAt'
  | 'githubCacheDirty'
  | 'githubCacheGeneration'
  | 'lastDurableWriteGeneration'
  | 'pendingGithubCacheWrite'
  | 'pendingProfileFlushes'
  | 'pendingProfileMaintenance'
  | 'profileMaintenancePending'
  | 'profileStateAuthority'
  | 'quitFlushPromise'
  | 'quitFlushStarted'
  | 'staleGithubCacheTempCleanup'
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
    writeGithubCacheSnapshotSync(this)
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

  flushPendingOrThrowAsync(
    options: { signal?: AbortSignal; drainToStableGeneration?: boolean } = {}
  ): Promise<void> {
    const { runtime } = this[writeFlushBarrierOperationsContext]
    if (runtime.writesFrozen || runtime.profileMaintenancePending || runtime.quitFlushStarted) {
      return Promise.reject(new Error('Cannot flush while persistence is finalized'))
    }
    return flushCurrentStateAsync(this, {
      signal: options.signal,
      drainToStableGeneration: options.drainToStableGeneration,
      requireInitialGenerationDurable: true
    })
  }
}

export async function flushDurableStateOrThrowAsync(
  owner: WriteFlushBarrierOperations
): Promise<void> {
  const { runtime, writes } = owner[writeFlushBarrierOperationsContext]
  if (runtime.writesFrozen || runtime.profileMaintenancePending || runtime.quitFlushStarted) {
    throw new Error('Cannot flush while persistence is finalized')
  }
  return runProfileStateFlush(runtime, async () => {
    for (;;) {
      if (runtime.writeTimer) {
        clearTimeout(runtime.writeTimer)
        runtime.writeTimer = null
      }
      runtime.firstPendingSaveAt = null
      const generation = runtime.writeGeneration
      await enqueueWrite(writes)
      if (generation === runtime.writeGeneration) {
        break
      }
    }
  })
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
        await writeGithubCacheSnapshotAsync(owner, final, signal)
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

export async function writeGithubCacheSnapshotAsync(
  owner: WriteFlushBarrierOperations,
  drainToStableGeneration = true,
  signal?: AbortSignal
): Promise<void> {
  const { runtime } = owner[writeFlushBarrierOperationsContext]
  if (!runtime.githubCacheDirty) {
    return
  }
  const previousWrite = runtime.pendingGithubCacheWrite ?? runtime.staleGithubCacheTempCleanup
  const nextWrite = previousWrite
    .then(async () => {
      while (runtime.githubCacheDirty) {
        if (signal?.aborted) {
          throw new Error('GitHub cache flush aborted')
        }
        const generation = runtime.githubCacheGeneration
        const cacheFile = getGithubCacheFile(runtime.dataFile)
        const tmpFile = durableWriteTempPath(cacheFile)
        let renamed = false
        try {
          await writeFile(tmpFile, JSON.stringify(runtime.state.githubCache), 'utf-8')
          if (generation === runtime.githubCacheGeneration) {
            await rename(tmpFile, cacheFile)
            renamed = true
            if (generation === runtime.githubCacheGeneration) {
              runtime.githubCacheDirty = false
            }
          }
        } finally {
          if (!renamed) {
            await rm(tmpFile).catch(() => {})
          }
        }
        if (signal?.aborted) {
          throw new Error('GitHub cache flush aborted')
        }
        if (!drainToStableGeneration) {
          break
        }
      }
    })
    .catch((err) => {
      console.warn('[persistence] Failed to write github cache snapshot:', err)
    })
    .finally(() => {
      if (runtime.pendingGithubCacheWrite === nextWrite) {
        runtime.pendingGithubCacheWrite = null
      }
    })
  runtime.pendingGithubCacheWrite = nextWrite
  await nextWrite
}

export function writeGithubCacheSnapshotSync(owner: WriteFlushBarrierOperations): void {
  const { runtime } = owner[writeFlushBarrierOperationsContext]
  if (!runtime.githubCacheDirty) {
    return
  }
  if (runtime.pendingGithubCacheWrite) {
    void writeGithubCacheSnapshotAsync(owner)
    return
  }
  const cacheFile = getGithubCacheFile(runtime.dataFile)
  const generation = runtime.githubCacheGeneration
  const tmpFile = durableWriteTempPath(cacheFile)
  try {
    writeFileSync(tmpFile, JSON.stringify(runtime.state.githubCache), 'utf-8')
    renameSync(tmpFile, cacheFile)
    if (generation === runtime.githubCacheGeneration) {
      runtime.githubCacheDirty = false
    }
  } catch (err) {
    try {
      unlinkSync(tmpFile)
    } catch {}
    console.warn('[persistence] Failed to write github cache snapshot:', err)
  }
}

export function installWriteFlushBarrierOperationsContext(
  target: WriteFlushBarrierOperations,
  source: WriteFlushBarrierOperations
): void {
  Object.defineProperty(target, writeFlushBarrierOperationsContext, {
    value: source[writeFlushBarrierOperationsContext]
  })
}
