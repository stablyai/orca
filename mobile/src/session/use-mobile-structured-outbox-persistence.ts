import { useCallback, useRef } from 'react'
import {
  saveMobileStructuredOutbox,
  type MobileStructuredOutboxEntry
} from './mobile-structured-outbox-store'

export function useMobileStructuredOutboxPersistence() {
  const persistTailRef = useRef<Promise<void>>(Promise.resolve())

  return useCallback((sessionId: string, entries: MobileStructuredOutboxEntry[]) => {
    const write = persistTailRef.current.then(() => saveMobileStructuredOutbox(sessionId, entries))
    persistTailRef.current = write.catch(() => {})
    return write
  }, [])
}
