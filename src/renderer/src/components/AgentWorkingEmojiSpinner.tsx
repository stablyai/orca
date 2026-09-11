import React from 'react'
import { cn } from '@/lib/utils'

const EMOJI_SPINNER_ANIMATION_NAME = 'agent-working-emoji-rotate'

// Why: anchoring the Web Animation timeline gives late mounts the same phase as
// existing spinners without recurring JS, mirroring AgentWorkingSpinner.
function syncEmojiSpinnerPhase(el: HTMLSpanElement | null): void {
  if (el === null || typeof el.getAnimations !== 'function') {
    return
  }

  const animation = el
    .getAnimations()
    .find(
      (candidate) =>
        'animationName' in candidate && candidate.animationName === EMOJI_SPINNER_ANIMATION_NAME
    )
  if (animation !== undefined) {
    animation.startTime = 0
  }
}

function handleEmojiSpinnerAnimationStart(event: React.AnimationEvent<HTMLSpanElement>): void {
  if (event.animationName === EMOJI_SPINNER_ANIMATION_NAME) {
    syncEmojiSpinnerPhase(event.currentTarget)
  }
}

// Why: the working-state emoji rotates via CSS (.agent-working-emoji-spinner in
// main.css) so rotation runs on the compositor and never touches the input
// thread. Callers size it via className (size-2 etc.).
export function AgentWorkingEmojiSpinner({
  emoji,
  className
}: {
  emoji: string
  className?: string
}): React.JSX.Element {
  return (
    <span
      onAnimationStart={handleEmojiSpinnerAnimationStart}
      data-agent-emoji-spinner=""
      aria-hidden="true"
      className={cn(
        'agent-working-emoji-spinner inline-flex items-center justify-center leading-none',
        className
      )}
    >
      <span className="inline-flex items-center justify-center text-[0.9em]">{emoji}</span>
    </span>
  )
}
