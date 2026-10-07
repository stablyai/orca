/**
 * One spelling of the cache's path arithmetic.
 *
 * Its own module, and deliberately importing nothing: `generation-store-file-system.ts` owns the
 * same uri dialect but loads `expo-file-system` for the adapter, and the store's whole testability
 * rests on never importing that. A value taken from there would pull the native module into every
 * module that addresses the cache.
 */
export function joinUri(...segments: readonly string[]): string {
  return segments.map((segment) => segment.replace(/\/+$/, '')).join('/')
}
