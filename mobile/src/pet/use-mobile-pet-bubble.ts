import { useEffect, useRef, useState } from 'react'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../src/shared/agent-status-types'
import {
  formatPetBubbleText,
  petBubbleWinnerKey,
  pickPetBubbleLine,
  selectPetBubbleWinner,
  type PetBubbleAgent,
  type PetBubbleMood
} from '../../../src/shared/pet-bubble-text'

/**
 * What the pet says on the phone.
 *
 * The desktop equivalent is usePetBubbleText. Both own only show/hold/fade
 * timing and a localized phrase bank; WHICH mood and WHOSE is decided once, in
 * shared/pet-bubble-text, so the two surfaces cannot disagree about what the
 * creature is reacting to.
 *
 * Why this exists at all: the pet is exclusive, so while the phone holds it the
 * desktop overlay renders nothing — bubble included. Without a bubble here,
 * agent status had no voice anywhere for as long as the pet was on the phone.
 */

/** Matches the desktop hold window. A bubble that lingers longer on one screen
 *  than the other would make the same event read as two different events. */
const BUBBLE_HOLD_MS = 3000

// Phrase bank stays per-surface: it is localized copy, and the phone has its own
// i18n story. The desktop's wording is mirrored deliberately — same creature,
// same voice.
function moodLines(mood: PetBubbleMood): string[] {
  switch (mood) {
    case 'waiting':
      return ['waiting…', 'your turn', 'all yours']
    case 'failed':
      return ['cancelled', 'stopped', 'interrupted']
    case 'waving':
      return ['done!', 'finished!', 'all set!']
    default:
      return ['working…', 'on it…', 'in progress…']
  }
}

function countSuffix(extra: number): string {
  return `+${extra}`
}

export function useMobilePetBubble(agents: readonly PetBubbleAgent[]): string | null {
  const [visible, setVisible] = useState(false)
  const [text, setText] = useState<string | null>(null)
  const lastKeyRef = useRef('')
  const lastLineRef = useRef('')
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // Re-evaluated on every agents change rather than on a timer: the phone only
  // learns about agent state when a worktree.ps response lands, so there is
  // nothing new to say between updates.
  const winner = selectPetBubbleWinner(agents, Date.now(), AGENT_STATUS_STALE_AFTER_MS)
  const key = petBubbleWinnerKey(winner)

  useEffect(() => {
    if (key === lastKeyRef.current) {
      return
    }
    lastKeyRef.current = key
    clearTimeout(timerRef.current)

    if (!winner) {
      setVisible(false)
      return
    }

    const line = pickPetBubbleLine(moodLines(winner.mood), lastLineRef.current)
    lastLineRef.current = line
    setText(formatPetBubbleText(winner, line, countSuffix))
    setVisible(true)
    timerRef.current = setTimeout(() => setVisible(false), BUBBLE_HOLD_MS)
    // `winner` is intentionally not a dep: it is a fresh object every render and
    // would retrigger constantly. `key` is its identity.
  }, [key, winner])

  useEffect(() => () => clearTimeout(timerRef.current), [])

  return visible ? text : null
}
