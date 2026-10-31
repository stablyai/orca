import type { WebContents } from 'electron'
import type { Store } from '../persistence'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'
import { isWorkspacePresentationKey } from '../../shared/workspace-presentation'

/** Client main publishes its placement cache locally; raw host frames keep their own structure. */
export function workspacePresentationPublication(store: Store) {
  const readers = new Set<WebContents>()
  store.onStateWritten((domains) => {
    if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
      return
    }
    const keys = domains?.filter(isWorkspacePresentationKey)
    if (!keys?.length || !readers.size) {
      return
    }
    const changed = store.getWorkspacePresentations(keys)
    const removed = keys.filter((key) => !changed[key])
    for (const reader of readers) {
      if (!reader.isDestroyed()) {
        reader.send('session:presentations-changed', { changed, removed })
      }
    }
  })
  return (reader: WebContents): void => {
    if (readers.has(reader)) {
      return
    }
    readers.add(reader)
    reader.once('destroyed', () => readers.delete(reader))
  }
}
