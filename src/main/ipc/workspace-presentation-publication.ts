import type { WebContents } from 'electron'
import type { Store } from '../persistence'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'
import { isWorkspacePresentationKey } from '../../shared/workspace-presentation'
import { workspacePresentationIntentFields } from '../../shared/workspace-presentation-user-intent'

/** Client main publishes its placement cache locally; raw host frames keep their own structure. */
export function workspacePresentationPublication(store: Store) {
  if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
    return (_reader: WebContents): void => {}
  }
  const readers = new Set<WebContents>()
  store.onStateWritten((domains) => {
    const keys = domains?.filter(isWorkspacePresentationKey)
    if (!keys?.length) {
      return
    }
    const changed = store.getWorkspacePresentations(keys)
    const removed = keys.filter((key) => !changed[key])
    const intent = Object.fromEntries(
      Object.entries(changed).flatMap(([key, document]) => {
        const fields = document ? workspacePresentationIntentFields(document) : []
        return fields.length ? [[key, fields]] : []
      })
    )
    for (const reader of readers) {
      if (!reader.isDestroyed()) {
        reader.send('session:presentations-changed', {
          changed,
          removed,
          ...(Object.keys(intent).length ? { intent } : {})
        })
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
