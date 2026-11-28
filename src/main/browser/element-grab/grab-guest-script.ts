import { COMPOSED_TREE_SCRIPT } from '../../../shared/browser/element-grab/browser-composed-tree-script'
import { GRAB_GUEST_CONTENT_SCRIPT } from './grab-guest-content-script'
import { GRAB_GUEST_ELEMENT_CONTEXT_SCRIPT } from './grab-guest-element-context-script'
import { GRAB_GUEST_FOUNDATION_SCRIPT } from './grab-guest-foundation-script'
import { GRAB_GUEST_OVERLAY_SCRIPT } from './grab-guest-overlay-script'
import { GRAB_GUEST_REACT_SCRIPT } from './grab-guest-react-script'

/**
 * Runs in the guest through webContents.executeJavaScript and returns the picker's private control.
 * Every later picker action (await a pick, read the hover, place the label, tear down) goes through
 * that control, which only the isolated preload holds; nothing is reachable from page globals.
 */
export const GRAB_GUEST_ARM_SCRIPT = [
  GRAB_GUEST_FOUNDATION_SCRIPT,
  COMPOSED_TREE_SCRIPT,
  GRAB_GUEST_CONTENT_SCRIPT,
  GRAB_GUEST_ELEMENT_CONTEXT_SCRIPT,
  GRAB_GUEST_REACT_SCRIPT,
  GRAB_GUEST_OVERLAY_SCRIPT
].join('')
