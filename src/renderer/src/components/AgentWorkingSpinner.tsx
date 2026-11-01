import React from 'react'
import { cn } from '@/lib/utils'

const SPINNER_ANIMATION_NAME = 'agent-spinner-rotate'

// Anchor Web Animations only on animationstart for phase sync without recurring JS. Mount-time queries force style recalculation (~24ms/200 mounts).
function syncSpinnerPhase(el: HTMLSpanElement | null): void {
  if (el === null || typeof el.getAnimations !== 'function') {
    return
  }

  const animation = el
    .getAnimations()
    .find(
      (candidate) =>
        'animationName' in candidate && candidate.animationName === SPINNER_ANIMATION_NAME
    )
  if (animation !== undefined) {
    animation.startTime = 0
  }
}

function handleSpinnerAnimationStart(event: React.AnimationEvent<HTMLSpanElement>): void {
  if (event.animationName === SPINNER_ANIMATION_NAME) {
    syncSpinnerPhase(event.currentTarget)
  }
}

// CSS compositor rotation avoids JS input-thread work; callers provide size.
export function AgentWorkingSpinner({ className }: { className?: string }): React.JSX.Element {
  return (
    <span
      onAnimationStart={handleSpinnerAnimationStart}
      data-agent-spinner=""
      className={cn(
        // Fill the top under reduced motion so the frozen ring looks intentional (#9515).
        'agent-working-spinner block rounded-full border-2 border-agent-working border-t-transparent motion-reduce:border-t-agent-working',
        className
      )}
    />
  )
}
