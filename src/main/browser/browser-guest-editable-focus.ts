// Follows the renderer's editable-target guard; a focused frame hides its element, so treat it as editable.
const GUEST_EDITABLE_FOCUS_EXPRESSION = `(() => {
  let active = document.activeElement
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement
  return active?.isContentEditable === true ||
    ['INPUT', 'TEXTAREA', 'SELECT', 'IFRAME', 'FRAME', 'FENCEDFRAME', 'OBJECT', 'EMBED'].includes(active?.tagName)
})()`

/** A failed check counts as editable so the page keeps its key without an Orca action. */
export async function guestHasEditableFocus(guest: Electron.WebContents): Promise<boolean> {
  try {
    return (await guest.executeJavaScript(GUEST_EDITABLE_FOCUS_EXPRESSION)) !== false
  } catch {
    return true
  }
}
