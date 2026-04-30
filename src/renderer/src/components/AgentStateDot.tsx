import React from 'react'
import { cn } from '@/lib/utils'

// Why: shared state-dot primitive so the dashboard and the sidebar's agent
// hover render the same state vocabulary identically. The dot sits next to the
// agent icon (Claude/Codex/etc.) — they are two distinct glyphs: one for *who*
// (icon) and one for *what state* (dot). Keeping them separate keeps each
// glyph scannable at a glance instead of fused into a single decorated icon.

export type AgentDotState =
  | 'working'
  | 'blocked'
  | 'waiting'
  | 'done'
  | 'idle'
  // Why: the sidebar's title-based status flow (StatusIndicator/WorktreeCard)
  // collapses blocked + waiting into a single "needs attention" state. Keep
  // this as a distinct member so that flow can render without inventing a new
  // vocabulary, but treat it identically to `blocked` visually.
  | 'permission'

export function agentStateLabel(state: AgentDotState): string {
  switch (state) {
    case 'working':
      return 'Working'
    case 'blocked':
      return 'Blocked'
    case 'waiting':
      return 'Waiting for input'
    case 'done':
      return 'Done'
    case 'idle':
      return 'Idle'
    case 'permission':
      return 'Needs attention'
  }
}

type Props = {
  state: AgentDotState
  size?: 'sm' | 'md'
  className?: string
}

export const AgentStateDot = React.memo(function AgentStateDot({
  state,
  size = 'sm',
  className
}: Props): React.JSX.Element {
  const box = size === 'md' ? 'h-3 w-3' : 'h-2.5 w-2.5'
  const inner = size === 'md' ? 'size-2' : 'size-1.5'

  if (state === 'working') {
    return (
      <span
        className={cn('inline-flex shrink-0 items-center justify-center', box, className)}
        aria-label={agentStateLabel(state)}
      >
        <span
          className={cn(
            'block rounded-full border-2 border-yellow-500 border-t-transparent animate-spin',
            inner
          )}
        />
      </span>
    )
  }

  return (
    <span
      className={cn('inline-flex shrink-0 items-center justify-center', box, className)}
      aria-label={agentStateLabel(state)}
    >
      <span
        className={cn(
          'block rounded-full',
          inner,
          state === 'blocked' || state === 'waiting' || state === 'permission'
            ? 'bg-red-500'
            : state === 'done'
              ? // Why: emerald-500 matches StatusIndicator's done dot so the
                // dashboard and sidebar read as the same state.
                'bg-emerald-500'
              : 'bg-neutral-500/40'
        )}
      />
    </span>
  )
})
