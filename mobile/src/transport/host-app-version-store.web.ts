/**
 * Web sibling: the page keeps no record of the host's app version, because nothing in it reads one.
 *
 * The record exists for the native troubleshoot screen, which reads it through
 * `diagnostics/native-diagnostics-operations.ts` when it has no live version; that module is not in
 * the page's bundle. The native file writes `orca:host-app-version:v1:<hostId>` through
 * AsyncStorage, which inside the page is the bridge's adapter, and the key is not one the page was
 * handed — so every mount that read `status.get` posted a write the shell refused and logged as
 * `storage-write-dropped`. A key the page only writes is not page state, so it is not admitted
 * through the storage seam (`page-storage-keys.ts`): the page stops asking instead.
 */
export const loadHostAppVersion = (_hostId: string): Promise<string | null> => Promise.resolve(null)

export const recordHostAppVersion = (_hostId: string, _value: unknown): Promise<void> =>
  Promise.resolve()
