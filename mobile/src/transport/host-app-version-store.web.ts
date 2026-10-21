/**
 * Web sibling: the page keeps no record of the host's app version, because nothing in it reads one
 * — the reader is the native troubleshoot screen's, outside this bundle. Not admitted through the
 * storage seam for that reason: a key the page only writes is not page state, so `status.get` had
 * every mount post `orca:host-app-version:v1:<hostId>` for the bridge to refuse and log.
 */
export const loadHostAppVersion = (_hostId: string): Promise<string | null> => Promise.resolve(null)

export const recordHostAppVersion = (_hostId: string, _value: unknown): Promise<void> =>
  Promise.resolve()
