/**
 * Why always leave: Electron silently cancels a navigation the page asks to confirm unless a listener
 * allows it, and wants the answer synchronously, so asking would freeze the main process until answered.
 */
export function allowPageUnload(event: Electron.Event): void {
  event.preventDefault()
}
