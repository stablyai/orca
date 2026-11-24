import { useSyncExternalStore } from 'react'

// A blank tab made from + opens with its address field focused, once; revisiting it later doesn't.
// Marked when the create reply lands, which can be after the tab's pane has already mounted.
const awaitingFocus = new Set<string>()
const listeners = new Set<() => void>()

function changed(): void {
  for (const listener of listeners) {
    listener()
  }
}

export function markNewBrowserTabForAddressFocus(browserPageId: string): void {
  awaitingFocus.add(browserPageId)
  changed()
}

/** Whether this tab's address field still owes its first focus; `done` settles it. */
export function useNewBrowserTabAddressFocus(browserPageId: string | null | undefined): {
  pending: boolean
  done: () => void
} {
  const pending = useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => browserPageId != null && awaitingFocus.has(browserPageId)
  )
  return {
    pending,
    done: () => {
      if (browserPageId != null && awaitingFocus.delete(browserPageId)) {
        changed()
      }
    }
  }
}
