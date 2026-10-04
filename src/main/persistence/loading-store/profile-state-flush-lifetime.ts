import type { StoreRuntimeState } from './store-runtime-state'

/** Lifecycle cleanup must join every accepted operation before closing its writer. */
export async function drainProfileStateOperations(
  operations: Iterable<Promise<unknown> | null | undefined>
): Promise<void> {
  const settled = await Promise.allSettled(
    Array.from(operations, (operation) => Promise.resolve(operation))
  )
  for (const result of settled) {
    if (result.status === 'rejected') {
      throw result.reason
    }
  }
}

/** A flush may dispatch again after SQL completes while its sidecars are still pending. */
export async function runProfileStateFlush(
  runtime: Pick<StoreRuntimeState, 'pendingProfileFlushes'>,
  operation: () => Promise<void>
): Promise<void> {
  let finish!: () => void
  const pending = new Promise<void>((resolve) => {
    finish = resolve
  })
  runtime.pendingProfileFlushes.add(pending)
  try {
    await operation()
  } finally {
    // Each caller owns its result; lifecycle barriers may retry a known failed capture.
    runtime.pendingProfileFlushes.delete(pending)
    finish()
  }
}
