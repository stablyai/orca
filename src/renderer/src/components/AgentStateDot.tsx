import React from 'react'
import { Activity, CircleCheck, CircleDashed } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import { AgentQuestionIcon } from '@/components/AgentQuestionIcon'
import { AgentWorkingSpinner } from '@/components/AgentWorkingSpinner'
import {
  AgentProgressRing,
  formatAgentProgressPercent,
  type AgentProgressRingTone
} from '@/components/AgentProgressRing'
import {
  StateIndicatorTooltip,
  type StateIndicatorTooltipSide
} from '@/components/StateIndicatorTooltip'

// Share state glyphs across agent surfaces. Keep the agent identity icon separate; completion uses a check while sidebar StatusIndicator uses an emerald dot/tooltip.

export type AgentDotState =
  | 'working'
  | 'monitoring'
  | 'blocked'
  | 'waiting'
  | 'interrupted'
  // Transcript-derived failure is an outcome, distinct from live blocked attention.
  | 'failed'
  | 'done'
  | 'idle'
  // A live PTY with stale reporting proves only missing evidence, not idle/work/completion.
  | 'unverifiable'
  // The turn ended without a proven outcome; use the missing-evidence glyph, never completion.
  | 'unconfirmed'
  // Sidebar combines blocked/waiting as permission; retain its vocabulary with the shared question glyph/token.
  | 'permission'

/** Return the accessible label shared by every visual agent-state marker. */
export function agentStateLabel(state: AgentDotState): string {
  switch (state) {
    case 'working':
      return translate('auto.components.AgentStateDot.working', 'Working')
    case 'monitoring':
      return translate('auto.components.AgentStateDot.monitoring', 'Monitoring background tasks')
    case 'blocked':
      return translate('auto.components.AgentStateDot.blocked', 'Blocked')
    case 'waiting':
      return translate('auto.components.AgentStateDot.waiting', 'Waiting for input')
    case 'interrupted':
      return translate('auto.components.AgentStateDot.interrupted', 'Interrupted')
    case 'failed':
      return translate('auto.components.AgentStateDot.failed', 'Failed')
    case 'done':
      return translate('auto.components.AgentStateDot.done', 'Done')
    case 'idle':
      return translate('auto.components.AgentStateDot.idle', 'Idle')
    case 'unverifiable':
      return translate('auto.components.AgentStateDot.unverifiable', 'No recent update')
    case 'unconfirmed':
      return translate('auto.components.AgentStateDot.unconfirmed', 'Couldn’t confirm')
    case 'permission':
      return translate('auto.components.AgentStateDot.permission', 'Needs attention')
  }
}

type Props = {
  state: AgentDotState
  size?: 'sm' | 'md'
  className?: string
  /** Overrides the hover tooltip; null suppresses it for an existing tooltip. */
  title?: string | null
  tooltipSide?: StateIndicatorTooltipSide
  /** Program-reported 0–100; live states then draw a filling ring instead of the spinner/glyph. */
  progress?: number
}

type ProgressRing = { tone: AgentProgressRingTone; percent: number }

// Finished rows’ last percentages must not imply work remains in flight.
function progressRing(state: AgentDotState, progress: number | undefined): ProgressRing | null {
  if (progress === undefined) {
    return null
  }
  if (state === 'working') {
    return { tone: 'working', percent: progress }
  }
  return state === 'waiting' || state === 'blocked' || state === 'permission'
    ? { tone: 'attention', percent: progress }
    : null
}

function withRingPercent(baseLabel: string, ring: ProgressRing | null): string {
  return ring ? `${baseLabel} · ${formatAgentProgressPercent(ring.percent)}` : baseLabel
}

/** A state's label, with the percentage only when AgentStateDot draws a progress ring for it. */
export function agentStateProgressLabel(
  state: AgentDotState,
  progress: number | undefined,
  baseLabel: string = agentStateLabel(state)
): string {
  return withRingPercent(baseLabel, progressRing(state, progress))
}

/** Render the compact state glyph used by agent rows and terminal tabs. */
export const AgentStateDot = React.memo(function AgentStateDot({
  state,
  size = 'sm',
  className,
  title,
  tooltipSide,
  progress
}: Props): React.JSX.Element {
  useUiLanguageRevision()
  const box = size === 'md' ? 'h-3 w-3' : 'h-2.5 w-2.5'
  const inner = size === 'md' ? 'size-2' : 'size-1.5'
  const icon = size === 'md' ? 'size-3' : 'size-2.5'
  const ring = progressRing(state, progress)
  const label = withRingPercent(agentStateLabel(state), ring)
  const tooltipLabel = title === null ? null : (title ?? label)

  let indicator: React.JSX.Element

  if (ring) {
    // Announce the label once on the progressbar itself.
    indicator = (
      <span className={cn('inline-flex shrink-0 items-center justify-center', box, className)}>
        <AgentProgressRing percent={ring.percent} tone={ring.tone} label={label} className={icon} />
      </span>
    )
  } else if (state === 'working') {
    indicator = (
      <span
        className={cn('inline-flex shrink-0 items-center justify-center', box, className)}
        aria-label={agentStateLabel(state)}
      >
        <AgentWorkingSpinner className={inner} />
      </span>
    )
  } else if (state === 'monitoring') {
    indicator = (
      <span
        className={cn('inline-flex shrink-0 items-center justify-center', box, className)}
        aria-label={agentStateLabel(state)}
      >
        <Activity className={cn('text-agent-working', icon)} aria-hidden="true" />
      </span>
    )
  } else if (state === 'done') {
    // A check distinguishes reported completion from live/idle dots; sidebar StatusIndicator intentionally differs.
    indicator = (
      <span
        className={cn('inline-flex shrink-0 items-center justify-center', box, className)}
        aria-label={agentStateLabel(state)}
      >
        <CircleCheck className={cn('text-emerald-500', icon)} aria-hidden="true" />
      </span>
    )
  } else if (state === 'unverifiable' || state === 'unconfirmed') {
    // A dashed amber ring reports missing evidence without claiming progress or completion.
    indicator = (
      <span
        className={cn('inline-flex shrink-0 items-center justify-center', box, className)}
        aria-label={agentStateLabel(state)}
      >
        <CircleDashed className={cn('text-amber-500', icon)} aria-hidden="true" />
      </span>
    )
  } else if (state === 'permission' || state === 'waiting') {
    indicator = (
      <span
        className={cn('inline-flex shrink-0 items-center justify-center', box, className)}
        aria-label={agentStateLabel(state)}
      >
        <AgentQuestionIcon className={icon} />
      </span>
    )
  } else {
    indicator = (
      <span
        className={cn('inline-flex shrink-0 items-center justify-center', box, className)}
        aria-label={agentStateLabel(state)}
      >
        <span
          className={cn(
            'block rounded-full',
            inner,
            state === 'blocked' || state === 'failed'
              ? 'bg-red-500'
              : // User Stop is muted, not a fault or completion.
                state === 'interrupted'
                ? 'bg-muted-foreground'
                : 'bg-neutral-500/40'
          )}
        />
      </span>
    )
  }

  return (
    <StateIndicatorTooltip label={tooltipLabel} side={tooltipSide}>
      {indicator}
    </StateIndicatorTooltip>
  )
})
