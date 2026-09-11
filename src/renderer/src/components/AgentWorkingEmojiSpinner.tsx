import React from 'react'
import { cn } from '@/lib/utils'
import { createSpinnerAnimationStartHandler } from './spinner-phase-sync'

const EMOJI_SPINNER_ANIMATION_NAME = 'agent-working-emoji-rotate'

const handleEmojiSpinnerAnimationStart = createSpinnerAnimationStartHandler(
  EMOJI_SPINNER_ANIMATION_NAME
)

/**
 * Working-state indicator that spins the workspace's chosen emoji instead of the
 * generic ring. Rotation animates via CSS (.agent-working-emoji-spinner in
 * main.css) so it runs on the compositor and never touches the input thread.
 * Callers size it via className (size-2 etc.).
 */
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
