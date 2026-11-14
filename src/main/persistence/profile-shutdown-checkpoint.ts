import type { Store } from './loading-store/store'

/** Save current state without closing the writer while removal still owns it. */
export function beginProfileShutdownCheckpoint(
  store: Pick<Store, 'flushPendingOrThrowAsync'> | null | undefined,
  paneGridFlush?: Promise<void> | null
): Promise<void> {
  const checkpoint = Promise.resolve(paneGridFlush).then(async () => {
    await store?.flushPendingOrThrowAsync({ drainToStableGeneration: false, fullCheckpoint: true })
  })
  void checkpoint.catch((error) =>
    console.error('[persistence] Failed to checkpoint before shutdown:', error)
  )
  return checkpoint
}
