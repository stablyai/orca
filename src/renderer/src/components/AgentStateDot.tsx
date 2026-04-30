import React from 'react'
import { CircleCheck } from 'lucide-react'
import { cn } from '@/lib/utils'

// Why: shared state-indicator primitive so the dashboard and the sidebar's
// agent hover render the same state vocabulary identically. Most states render
// as a dot; 'working' renders a spinner and 'done' renders a check icon. It
// sits next to the agent icon (Claude/Codex/etc.) — two distinct glyphs: one
// for *who* (agent icon) and one for *what state* (this indicator). Keeping
// them separate keeps each scannable instead of fused into one decorated icon.

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
  const icon = size === 'md' ? 'size-3' : 'size-2.5'

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

  if (state === 'done') {
    // Why: match StatusIndicator — agent-reported completion renders as an
    // emerald check icon instead of an emerald dot so 'done' is visually
    // distinct from other emerald states (e.g., sidebar 'active'). Keeping
    // the dashboard and sidebar on the same glyph for 'done' is the whole
    // point of this shared primitive (see file header).
    return (
      <span
        className={cn('inline-flex shrink-0 items-center justify-center', box, className)}
        aria-label={agentStateLabel(state)}
      >
        <CircleCheck className={cn('text-emerald-500', icon)} aria-hidden="true" />
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
            : 'bg-neutral-500/40'
        )}
      />
    </span>
  )
})
