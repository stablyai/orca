import { useState } from 'react'

/**
 * Latches true the first time `open` becomes true so a lazy dialog surface can stay unmounted
 * at startup and then remain mounted across close animations once first opened.
 */
export function useLatchedOpen(open: boolean): boolean {
  const [hasOpened, setHasOpened] = useState(open)
  if (open && !hasOpened) {
    setHasOpened(true)
  }
  return hasOpened
}
