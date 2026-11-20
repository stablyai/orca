import type { WebContents } from 'electron'
import {
  BROWSER_GRAB_SELECTED_ATTRIBUTE,
  GRAB_SELECTED_ELEMENT_LOOKUP_SCRIPT
} from '../../../shared/browser/annotations/browser-annotation-viewport-bridge'
import { executeGrabScript } from './grab-guest-execution'

const GRAB_PICK_WORLD_ID = 1_209

/** Bind the selected DOM node before the picker can rearm and remove its cross-world marker. */
export function retainPickedElement(guest: WebContents, selectionId: string): Promise<boolean> {
  return executeGrabScript(guest, () =>
    guest.executeJavaScriptInIsolatedWorld(GRAB_PICK_WORLD_ID, [
      {
        code: `(function() {
      const selectedAttribute = ${JSON.stringify(BROWSER_GRAB_SELECTED_ATTRIBUTE)};
      const selectionId = ${JSON.stringify(selectionId)};
      ${GRAB_SELECTED_ELEMENT_LOOKUP_SCRIPT}
      const found = findMarked(document);
      const target = found[0] || findMarkedInShadowRoots(document)[0];
      globalThis.__orcaPickedElement = { selectionId, target: target ? new WeakRef(target) : null };
      return Boolean(target && target.isConnected);
    })()`
      }
    ])
  )
}

export function isPickedElementPresent(guest: WebContents, selectionId: string): Promise<boolean> {
  return executeGrabScript(guest, () =>
    guest.executeJavaScriptInIsolatedWorld(GRAB_PICK_WORLD_ID, [
      {
        code: `(function() {
      const pick = globalThis.__orcaPickedElement;
      const target = pick && pick.selectionId === ${JSON.stringify(selectionId)} && pick.target?.deref();
      return Boolean(target && target.isConnected);
    })()`
      }
    ])
  )
}
