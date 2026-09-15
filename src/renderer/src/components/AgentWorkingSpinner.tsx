import React from 'react'
import { cn } from '@/lib/utils'
import { createSpinnerAnimationStartHandler } from './spinner-phase-sync'

const SPINNER_ANIMATION_NAME = 'agent-spinner-rotate'

const handleSpinnerAnimationStart = createSpinnerAnimationStartHandler(SPINNER_ANIMATION_NAME)

/**
 * Yellow working-state ring. Rotation animates via CSS (.agent-working-spinner
 * in main.css) so it runs on the compositor and never touches the input thread.
 * Callers size it via className (size-2 etc.).
 */
export function AgentWorkingSpinner({ className }: { className?: string }): React.JSX.Element {
  return (
    <span
      onAnimationStart={handleSpinnerAnimationStart}
      data-agent-spinner=""
      className={cn(
        // Why: under reduced motion the animation is disabled, so fill the top
        // border too — a frozen transparent-top ring reads as a broken
        // spinner; a complete ring reads as an intentional static marker (#9515).
        'agent-working-spinner block rounded-full border-2 border-yellow-500 border-t-transparent motion-reduce:border-t-yellow-500',
        className
      )}
    />
  )
}
