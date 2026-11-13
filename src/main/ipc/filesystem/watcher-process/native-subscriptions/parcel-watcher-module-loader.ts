import type * as ParcelWatcher from '@parcel/watcher'

/** Native loading stays in the watcher child, across named and CommonJS exports. */
export async function loadParcelWatcher(): Promise<typeof ParcelWatcher> {
  const loaded = await import('@parcel/watcher')
  const watcher = typeof loaded.subscribe === 'function' ? loaded : loaded.default
  if (!watcher || typeof watcher.subscribe !== 'function') {
    throw new Error('parcel_watcher_module_invalid')
  }
  return watcher
}
