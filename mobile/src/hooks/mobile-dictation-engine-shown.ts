import { useState } from 'react'
import type { MobileDictationEngineShown } from './mobile-dictation-session-state'

export type ShowMobileDictationEngine = (
  kind: MobileDictationEngineShown['kind'],
  moved?: boolean
) => void

// The engine the UI shows by the timer: set when an engine starts hearing, cleared when the dictation ends.
export function useMobileDictationEngineShown() {
  const [shown, setShown] = useState<MobileDictationEngineShown | null>(null)
  const [show] = useState(
    (): ShowMobileDictationEngine =>
      (kind, moved = false) =>
        setShown((current) =>
          moved
            ? { kind, movedAt: Date.now() }
            : current?.kind === kind
              ? current
              : { kind, movedAt: null }
        )
  )
  const [clear] = useState(() => () => setShown(null))
  return { shown, show, clear }
}
