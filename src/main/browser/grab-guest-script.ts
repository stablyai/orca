import { GRAB_GUEST_CONTENT_SCRIPT } from './grab-guest-content-script'
import { GRAB_GUEST_ELEMENT_CONTEXT_SCRIPT } from './grab-guest-element-context-script'
import { GRAB_GUEST_FOUNDATION_SCRIPT } from './grab-guest-foundation-script'
import { GRAB_GUEST_OVERLAY_SCRIPT } from './grab-guest-overlay-script'
import { GRAB_GUEST_REACT_SCRIPT } from './grab-guest-react-script'
import {
  AWAIT_CLICK_SCRIPT,
  EXTRACT_HOVER_SCRIPT,
  FINALIZE_SCRIPT,
  TEARDOWN_SCRIPT
} from './grab-guest-selection-scripts'

type GuestScriptAction = 'arm' | 'awaitClick' | 'finalize' | 'extractHover' | 'teardown'

/**
 * Guest-page scripts for element grab mode. Executed via webContents.executeJavaScript.
 *
 * - `arm`: install the shadow-root overlay, hover listeners, and extraction logic
 * - `awaitClick`: return a Promise that resolves with the payload when the user clicks
 * - `finalize`: extract the payload for the currently hovered element and return it
 * - `extractHover`: extract the payload for the currently hovered element WITHOUT cleanup
 * - `teardown`: remove the overlay and all listeners
 */
export function buildGuestOverlayScript(action: GuestScriptAction): string {
  switch (action) {
    case 'arm':
      return ARM_SCRIPT
    case 'awaitClick':
      return AWAIT_CLICK_SCRIPT
    case 'finalize':
      return FINALIZE_SCRIPT
    case 'extractHover':
      return EXTRACT_HOVER_SCRIPT
    case 'teardown':
      return TEARDOWN_SCRIPT
  }
}

const ARM_SCRIPT = [
  GRAB_GUEST_FOUNDATION_SCRIPT,
  GRAB_GUEST_CONTENT_SCRIPT,
  GRAB_GUEST_ELEMENT_CONTEXT_SCRIPT,
  GRAB_GUEST_REACT_SCRIPT,
  GRAB_GUEST_OVERLAY_SCRIPT
].join('')
