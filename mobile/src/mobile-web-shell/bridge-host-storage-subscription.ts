import { subscribeMirroredKey } from '../storage/mirrored-storage-keys'
import { pageStorageEntriesForInit, pageStorageKeysForRoute } from './page-storage-keys'

export function subscribePageStorage(
  hostId: string,
  pathname: string,
  pageVersion: number | undefined,
  publish: (key: string, value: string | null) => void
): () => void {
  if ((pageVersion ?? 0) < 2) {
    return () => {}
  }
  const unsubscribers = pageStorageKeysForRoute(hostId, pathname).map((key) =>
    subscribeMirroredKey(key, (value) => {
      const { entries } = pageStorageEntriesForInit({ [key]: value ?? '' }, pageVersion)
      if (key in entries) {
        publish(key, value)
      }
    })
  )
  return () => unsubscribers.forEach((unsubscribe) => unsubscribe())
}
