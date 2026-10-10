import { useEffect, useState } from 'react'
import {
  createMobileDictationStreamSalvage,
  type FailedStreamFinishPhase
} from './mobile-dictation-stream-salvage'

/** The stream salvage for one dictation hook, with its finish phase as render state for the mic. */
export function useMobileDictationStreamSalvage() {
  const [phase, setPhase] = useState<FailedStreamFinishPhase>('none')
  const [salvage] = useState(() => createMobileDictationStreamSalvage(setPhase))
  useEffect(() => () => salvage.dispose(), [salvage])
  return { salvage, phase }
}
