import type { WebContents } from 'electron'
import { executeGrabScript, type GrabDocumentScope } from './grab-guest-execution'

/** The private preload captured the original object synchronously at the pick. */
export function retainPickedElement(
  guest: WebContents,
  selectionId: string,
  scope?: GrabDocumentScope
): Promise<boolean | null> {
  return isPickedElementPresent(guest, selectionId, true, scope)
}

export function isPickedElementPresent(
  guest: WebContents,
  selectionId: string,
  interactive = false,
  scope?: GrabDocumentScope
): Promise<boolean | null> {
  return executeGrabScript(guest, '', {
    pick: { selectionId, operation: 'present' },
    background: !interactive,
    loadedOnly: true,
    scope
  })
}
