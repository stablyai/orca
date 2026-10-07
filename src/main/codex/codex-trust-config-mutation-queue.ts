import { AsyncLocalStorage } from 'node:async_hooks'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'

const tailByTomlPath = new Map<string, Promise<void>>()
// Why: the grant lane runs inside the installer that already owns the file.
// AsyncLocalStorage survives awaits, so the inner acquire can see the outer
// one and pass through instead of queueing behind itself forever.
const heldKeys = new AsyncLocalStorage<ReadonlySet<string>>()

/**
 * Serializes Orca's own multi-step mutations of one Codex `config.toml` — hook
 * installs and their trust fallbacks, trust moves, and project trust — as a
 * single lane per file. A Codex trust session holds no lane: Codex writes its
 * own records.
 *
 * Why (#16441): these used to block the main thread, so two of them could
 * never be in flight at once. Now that they await, a second run could write
 * the file between another run's read and its dependent write.
 */
export function runExclusivelyForCodexTrustConfig<T>(
  tomlPath: string,
  run: () => Promise<T>
): Promise<T> {
  const key = normalizeRuntimePathForComparison(tomlPath)
  const held = heldKeys.getStore()
  if (held?.has(key)) {
    return run()
  }
  const owned = new Set(held ?? [])
  owned.add(key)
  const enter = (): Promise<T> => heldKeys.run(owned, run)
  const previous = tailByTomlPath.get(key) ?? Promise.resolve()
  // Why both handlers: a rejected predecessor must not cancel the queue.
  const result = previous.then(enter, enter)
  const tail = result.then(
    () => undefined,
    () => undefined
  )
  tailByTomlPath.set(key, tail)
  void tail.then(() => {
    if (tailByTomlPath.get(key) === tail) {
      tailByTomlPath.delete(key)
    }
  })
  return result
}
