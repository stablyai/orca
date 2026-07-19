import React from 'react'
import { CircleCheck } from 'lucide-react'
import { cn } from '@/lib/utils'

// Why: shared state-indicator primitive so the dashboard and the sidebar's
// agent hover share a single state vocabulary. Most states render as a dot;
// 'working' renders a spinner. 'done' intentionally diverges from the
// sidebar's StatusIndicator: the dashboard uses a check icon so completion
// is visually distinct from 'idle' (grey dot) and the sidebar's 'active'
// (emerald dot), while the sidebar collapses 'done'/'active' to the same
// emerald dot and relies on a tooltip. It sits next to the agent icon
// (Claude/Codex/etc.) — two distinct glyphs: one for *who* (agent icon) and
// one for *what state* (this indicator). Keeping them separate keeps each
// scannable instead of fused into one decorated icon.

export type AgentDotState =
  | 'working'
  | 'blocked'
  | 'waiting'
  | 'interrupted'
  // Why: AI Vault subagent rows report a transcript-derived failure, which is
  // an outcome (like 'done'), not a live attention state like 'blocked'.
  | 'failed'
  | 'done'
  | 'idle'
  // Why: title heuristics know only generic attention, not the exact blocker;
  // keep that aggregate state separate from explicit blocked and waiting rows.
  | 'permission'

/** Return the accessible label shared by every visual agent-state marker. */
export function agentStateLabel(state: AgentDotState): string {
  switch (state) {
    case 'working':
      return 'Working'
    case 'blocked':
      return 'Blocked'
    case 'waiting':
      return 'Waiting for input'
    case 'interrupted':
      return 'Interrupted'
    case 'failed':
      return 'Failed'
    case 'done':
      return 'Done'
    case 'idle':
      return 'Idle'
    case 'permission':
      return 'Needs attention'
  }
}

type Props = Pick<React.ComponentProps<'span'>, 'aria-label' | 'aria-hidden'> & {
  state: AgentDotState
  size?: 'sm' | 'md'
  className?: string
}

/** Render the compact state glyph used by agent rows and terminal tabs. */
export const AgentStateDot = React.memo(function AgentStateDot({
  state,
  size = 'sm',
  className,
  'aria-label': ariaLabel,
  'aria-hidden': ariaHidden
}: Props): React.JSX.Element {
  const box = size === 'md' ? 'h-3 w-3' : 'h-2.5 w-2.5'
  const inner = size === 'md' ? 'size-2' : 'size-1.5'
  const icon = size === 'md' ? 'size-3' : 'size-2.5'
  const hiddenFromAssistiveTech = ariaHidden === true || ariaHidden === 'true'
  const accessibilityProps = hiddenFromAssistiveTech
    ? ({ 'aria-hidden': ariaHidden } as const)
    : ({ role: 'img', 'aria-label': ariaLabel ?? agentStateLabel(state) } as const)

  if (state === 'working') {
    return (
      <span
        className={cn('inline-flex shrink-0 items-center justify-center', box, className)}
        {...accessibilityProps}
      >
        <span
          className={cn(
            // Why: match the sidebar worktree spinner's stepped cadence so
            // long-running visible agents do not keep a full-frame-rate loop.
            'block rounded-full border-2 border-status-working border-t-transparent [animation:spin_1s_steps(12,end)_infinite] motion-reduce:animate-none',
            inner
          )}
        />
      </span>
    )
  }

  if (state === 'done') {
    // Why: the dashboard lists many agents, so a check glyph scans well for
    // agent-reported completion and keeps 'done' visually distinct from
    // 'idle' and other dot states at a glance. The sidebar's StatusIndicator
    // intentionally diverges (emerald dot + tooltip) — see file header.
    return (
      <span
        className={cn('inline-flex shrink-0 items-center justify-center', box, className)}
        {...accessibilityProps}
      >
        <CircleCheck className={cn('text-status-success', icon)} aria-hidden="true" />
      </span>
    )
  }

  return (
    <span
      className={cn('inline-flex shrink-0 items-center justify-center', box, className)}
      {...accessibilityProps}
    >
      <span
        className={cn(
          'block rounded-full',
          inner,
          state === 'permission' || state === 'waiting'
            ? 'bg-status-attention'
            : state === 'blocked' || state === 'interrupted' || state === 'failed'
              ? 'bg-destructive'
              : 'bg-muted-foreground'
        )}
      />
    </span>
  )
})
