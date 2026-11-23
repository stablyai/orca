// Electron requires preventDefault() on will-prevent-unload to allow leaving the page.
export function allowPageUnload(event: Electron.Event): void {
  event.preventDefault()
}
