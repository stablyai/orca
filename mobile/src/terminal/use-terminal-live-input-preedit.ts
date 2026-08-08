import { useCallback, useState } from 'react'
import type { TerminalLiveInputChangeEvent } from './use-terminal-live-input-commit'

/**
 * Marking IMEs (Japanese kana, pinyin) withhold bytes until commit, so the terminal
 * echo shows nothing mid-composition and the input dock is the only place a preview
 * can appear. The commit hook tracks composition in a ref, which cannot drive a
 * render, so mirror the native marked-text bit into state alongside it.
 *
 * Byte behavior is untouched: the commit hook still owns every send decision.
 */
export function useTerminalLiveInputPreedit(
  handleLiveInputChange: (event: TerminalLiveInputChangeEvent) => void
): {
  readonly isComposing: boolean
  readonly handleLiveInputChangeWithPreedit: (event: TerminalLiveInputChangeEvent) => void
} {
  const [isComposing, setIsComposing] = useState(false)
  const handleLiveInputChangeWithPreedit = useCallback(
    (event: TerminalLiveInputChangeEvent) => {
      setIsComposing(event.nativeEvent.isComposing === true)
      handleLiveInputChange(event)
    },
    [handleLiveInputChange]
  )
  return { isComposing, handleLiveInputChangeWithPreedit }
}
