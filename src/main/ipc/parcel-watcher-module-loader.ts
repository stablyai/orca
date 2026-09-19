import type * as ParcelWatcher from '@parcel/watcher'

/** Normalize the CJS package while keeping native loading lazy. */
export async function loadParcelWatcher(): Promise<typeof ParcelWatcher> {
  const loaded = (await import('@parcel/watcher')) as typeof ParcelWatcher & {
    default?: typeof ParcelWatcher
  }
  // Packaged CJS wrappers need not expose statically discoverable named exports.
  const watcher = typeof loaded.subscribe === 'function' ? loaded : loaded.default
  if (!watcher || typeof watcher.subscribe !== 'function') {
    throw new Error('parcel_watcher_module_invalid')
  }
  return watcher
}
