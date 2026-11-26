import { useSyncExternalStore } from 'react'

export type LiveInputCapture = ReturnType<typeof createLiveInputCapture>

// Held outside React state so a keystroke re-renders only the field that reads it, not the session.
export function createLiveInputCapture() {
  let text = ''
  const listeners = new Set<() => void>()
  return {
    get: () => text,
    set: (next: string) => {
      if (next === text) {
        return
      }
      text = next
      for (const listener of listeners) {
        listener()
      }
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}

export function useLiveInputCaptureText(capture: LiveInputCapture): string {
  return useSyncExternalStore(capture.subscribe, capture.get)
}
