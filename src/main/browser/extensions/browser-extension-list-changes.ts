/** Tells Settings its extension list is stale: installs, updates, removals, load errors, held updates. */

const CHANGED_DELAY_MS = 50

let listener: (() => void) | null = null
let timer: NodeJS.Timeout | null = null

export function setBrowserExtensionListChangedListener(next: (() => void) | null): void {
  listener = next
}

// Why coalesce: one install commits, reloads and clears load errors in quick succession.
export function notifyBrowserExtensionListChanged(): void {
  if (!listener || timer) {
    return
  }
  timer = setTimeout(() => {
    timer = null
    listener?.()
  }, CHANGED_DELAY_MS)
}
