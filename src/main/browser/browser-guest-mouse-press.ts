import type { ResolveRenderer } from './browser-guest-renderer-target'
import { isAgentInjectingInput } from './agent-input-injection'

/**
 * A press in a page is the desktop user's signal for two things the embedder never sees: the
 * page's split becomes active (#22144), and the mouse back/forward buttons step its history on
 * release, as in Chrome. Returns whether the event was a press this handled.
 */
export function forwardGuestMousePress(
  guest: Electron.WebContents,
  browserTabId: string,
  resolveRenderer: ResolveRenderer,
  mouse: Electron.MouseInputEvent
): boolean {
  if (mouse.type !== 'mouseDown' && mouse.type !== 'mouseUp') {
    return false
  }
  // Why: agent tools click and press X1/X2 as page input; neither may move the user's split or history.
  if (isAgentInjectingInput(guest)) {
    return true
  }
  if (mouse.type === 'mouseDown') {
    resolveRenderer(browserTabId)?.send('ui:browserPagePointerDown', {
      browserPageId: browserTabId
    })
    return true
  }
  // Why a string: Electron reports side buttons as 'back'/'forward', which its typing omits.
  const button: string | undefined = mouse.button
  if (button === 'back' || button === 'forward') {
    resolveRenderer(browserTabId)?.send('ui:browserHistoryNavigate', {
      browserPageId: browserTabId,
      direction: button
    })
  }
  return true
}
