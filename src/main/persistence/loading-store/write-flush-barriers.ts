import { writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { rename, rm, writeFile } from 'node:fs/promises'
import { durableWriteTempPath } from '../../durable-file-write'
import { getGithubCacheFile } from './user-data-path'

import type { StoreRuntimeState } from './store-runtime-state'
import type { PrimaryStateWriteOperations } from './primary-state-writes'
import { enqueueWrite } from './primary-state-writes'

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
  | 'quitFlushPromise'
  | 'quitFlushStarted'
  | 'staleGithubCacheTempCleanup'
  | 'state'
  | 'writeGeneration'
  | 'writeTimer'
  | 'writesFrozen'
>

const writeFlushBarrierOperationsContext = Symbol('WriteFlushBarrierOperations')
type WriteFlushBarrierOperationsContext = {
  runtime: WriteFlushBarrierOperationsRuntime
  writes: PrimaryStateWriteOperations
}

export class WriteFlushBarrierOperations {
  readonly [writeFlushBarrierOperationsContext]: WriteFlushBarrierOperationsContext

  constructor(runtime: WriteFlushBarrierOperationsRuntime, writes: PrimaryStateWriteOperations) {
    this[writeFlushBarrierOperationsContext] = { runtime, writes }
  }

  flush(): void {
    this[writeFlushBarrierOperationsContext].runtime.automationListProjectionCache = null
    if (this[writeFlushBarrierOperationsContext].runtime.quitFlushStarted) {
      return
    }
    try {
      this[writeFlushBarrierOperationsContext].writes.flushOrThrow()
    } catch (err) {
      console.error('[persistence] Failed to flush state:', err)
    }
    try {
      this[writeFlushBarrierOperationsContext].writes.flushActiveViewPreferenceOrThrow()
    } catch (err) {
      console.error('[active-view] Failed to flush preference:', err)
    }
    writeGithubCacheSnapshotSync(this)
  }

  flushAsync(): Promise<void> {
    if (this[writeFlushBarrierOperationsContext].runtime.quitFlushPromise) {
      return this[writeFlushBarrierOperationsContext].runtime.quitFlushPromise
    }
    this[writeFlushBarrierOperationsContext].runtime.quitFlushStarted = true
    this[writeFlushBarrierOperationsContext].runtime.quitFlushPromise = flushCurrentStateAsync(
      this,
      true
    ).catch(() => {})
    return this[writeFlushBarrierOperationsContext].runtime.quitFlushPromise
  }

  flushPendingAsync(): Promise<void> {
    // Best-effort callers must not livelock while the live app keeps mutating state.
    return flushCurrentStateAsync(this, false, undefined, false).catch(() => {})
  }

  flushPendingOrThrowAsync(
    options: { signal?: AbortSignal; drainToStableGeneration?: boolean } = {}
  ): Promise<void> {
    if (
      this[writeFlushBarrierOperationsContext].runtime.writesFrozen ||
      this[writeFlushBarrierOperationsContext].runtime.quitFlushStarted
    ) {
      return Promise.reject(new Error('Cannot flush while persistence is finalized'))
    }
    return flushCurrentStateAsync(
      this,
      false,
      options.signal,
      options.drainToStableGeneration,
      true
    )
  }
}

export async function flushDurableStateOrThrowAsync(
  owner: WriteFlushBarrierOperations
): Promise<void> {
  if (
    owner[writeFlushBarrierOperationsContext].runtime.writesFrozen ||
    owner[writeFlushBarrierOperationsContext].runtime.quitFlushStarted
  ) {
    throw new Error('Cannot flush while persistence is finalized')
  }
  for (;;) {
    if (owner[writeFlushBarrierOperationsContext].runtime.writeTimer) {
      clearTimeout(owner[writeFlushBarrierOperationsContext].runtime.writeTimer)
      owner[writeFlushBarrierOperationsContext].runtime.writeTimer = null
    }
    owner[writeFlushBarrierOperationsContext].runtime.firstPendingSaveAt = null
    const generation = owner[writeFlushBarrierOperationsContext].runtime.writeGeneration
    await enqueueWrite(owner[writeFlushBarrierOperationsContext].writes)
    if (generation === owner[writeFlushBarrierOperationsContext].runtime.writeGeneration) {
      break
    }
  }
}

export async function flushCurrentStateAsync(
  owner: WriteFlushBarrierOperations,
  final: boolean,
  signal?: AbortSignal,
  drainToStableGeneration = true,
  requireInitialGenerationDurable = false
): Promise<void> {
  const requiredDurableGeneration = requireInitialGenerationDurable
    ? owner[writeFlushBarrierOperationsContext].runtime.writeGeneration
    : null
  for (;;) {
    if (signal?.aborted) {
      throw new Error('Persistence flush aborted')
    }
    if (owner[writeFlushBarrierOperationsContext].runtime.writeTimer) {
      clearTimeout(owner[writeFlushBarrierOperationsContext].runtime.writeTimer)
      owner[writeFlushBarrierOperationsContext].runtime.writeTimer = null
    }
    owner[writeFlushBarrierOperationsContext].runtime.firstPendingSaveAt = null
    const generation = owner[writeFlushBarrierOperationsContext].runtime.writeGeneration
    try {
      await enqueueWrite(owner[writeFlushBarrierOperationsContext].writes)
    } catch (error) {
      await (final
        ? owner[writeFlushBarrierOperationsContext].runtime.activeViewPreference.flushAsync()
        : owner[writeFlushBarrierOperationsContext].runtime.activeViewPreference.flushPendingAsync(
            signal
          ))
      await writeGithubCacheSnapshotAsync(owner, final, signal)
      throw error
    }
    await (final
      ? owner[writeFlushBarrierOperationsContext].runtime.activeViewPreference.flushAsync()
      : owner[writeFlushBarrierOperationsContext].runtime.activeViewPreference.flushPendingAsync(
          signal
        ))
    await writeGithubCacheSnapshotAsync(owner, final, signal)
    if (signal?.aborted) {
      throw new Error('Persistence flush aborted')
    }
    if (!drainToStableGeneration) {
      if (
        requiredDurableGeneration === null ||
        owner[writeFlushBarrierOperationsContext].runtime.lastDurableWriteGeneration >=
          requiredDurableGeneration
      ) {
        break
      }
      continue
    }
    if (generation === owner[writeFlushBarrierOperationsContext].runtime.writeGeneration) {
      break
    }
  }
}

export async function writeGithubCacheSnapshotAsync(
  owner: WriteFlushBarrierOperations,
  drainToStableGeneration = true,
  signal?: AbortSignal
): Promise<void> {
  if (!owner[writeFlushBarrierOperationsContext].runtime.githubCacheDirty) {
    return
  }
  const previousWrite =
    owner[writeFlushBarrierOperationsContext].runtime.pendingGithubCacheWrite ??
    owner[writeFlushBarrierOperationsContext].runtime.staleGithubCacheTempCleanup
  const nextWrite = previousWrite
    .then(async () => {
      while (owner[writeFlushBarrierOperationsContext].runtime.githubCacheDirty) {
        if (signal?.aborted) {
          throw new Error('GitHub cache flush aborted')
        }
        const generation = owner[writeFlushBarrierOperationsContext].runtime.githubCacheGeneration
        const cacheFile = getGithubCacheFile(
          owner[writeFlushBarrierOperationsContext].runtime.dataFile
        )
        const tmpFile = durableWriteTempPath(cacheFile)
        let renamed = false
        try {
          await writeFile(
            tmpFile,
            JSON.stringify(owner[writeFlushBarrierOperationsContext].runtime.state.githubCache),
            'utf-8'
          )
          if (
            generation === owner[writeFlushBarrierOperationsContext].runtime.githubCacheGeneration
          ) {
            await rename(tmpFile, cacheFile)
            renamed = true
            if (
              generation === owner[writeFlushBarrierOperationsContext].runtime.githubCacheGeneration
            ) {
              owner[writeFlushBarrierOperationsContext].runtime.githubCacheDirty = false
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
      if (owner[writeFlushBarrierOperationsContext].runtime.pendingGithubCacheWrite === nextWrite) {
        owner[writeFlushBarrierOperationsContext].runtime.pendingGithubCacheWrite = null
      }
    })
  owner[writeFlushBarrierOperationsContext].runtime.pendingGithubCacheWrite = nextWrite
  await nextWrite
}

export function writeGithubCacheSnapshotSync(owner: WriteFlushBarrierOperations): void {
  if (!owner[writeFlushBarrierOperationsContext].runtime.githubCacheDirty) {
    return
  }
  if (owner[writeFlushBarrierOperationsContext].runtime.pendingGithubCacheWrite) {
    void writeGithubCacheSnapshotAsync(owner)
    return
  }
  const cacheFile = getGithubCacheFile(owner[writeFlushBarrierOperationsContext].runtime.dataFile)
  const generation = owner[writeFlushBarrierOperationsContext].runtime.githubCacheGeneration
  const tmpFile = durableWriteTempPath(cacheFile)
  try {
    writeFileSync(
      tmpFile,
      JSON.stringify(owner[writeFlushBarrierOperationsContext].runtime.state.githubCache),
      'utf-8'
    )
    renameSync(tmpFile, cacheFile)
    if (generation === owner[writeFlushBarrierOperationsContext].runtime.githubCacheGeneration) {
      owner[writeFlushBarrierOperationsContext].runtime.githubCacheDirty = false
    }
  } catch (err) {
    try {
      unlinkSync(tmpFile)
    } catch {
      // Best-effort cleanup.
    }
    console.warn('[persistence] Failed to write github cache snapshot:', err)
  }
}

export function installWriteFlushBarrierOperationsContext(
  target: object,
  source: WriteFlushBarrierOperations
): void {
  Object.defineProperty(target, writeFlushBarrierOperationsContext, {
    value: source[writeFlushBarrierOperationsContext]
  })
}
