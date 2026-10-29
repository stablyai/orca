import { useEffect } from 'react'

let documentLeaveGuard: (() => boolean) | null = null

// The page-drawn host sidebar shares this document with the session it would replace, so it asks here before switching.
export function holdSessionLeave(): boolean {
  return documentLeaveGuard?.() ?? false
}

// Publish the open session's guard while it has a leave to hold; a true return keeps the session.
export function useSessionLeaveGuard(guard: (() => boolean) | null): void {
  useEffect(() => {
    if (guard === null) {
      return
    }
    documentLeaveGuard = guard
    return () => {
      if (documentLeaveGuard === guard) {
        documentLeaveGuard = null
      }
    }
  }, [guard])
}
