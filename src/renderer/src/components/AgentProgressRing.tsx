import React from 'react'
import { cn } from '@/lib/utils'

export type AgentProgressRingTone = 'working' | 'attention'

// Why a floor: a 1% arc on a small ring is invisible, which reads as "no progress shown".
const MIN_VISIBLE_PERCENT = 8

function clampPercent(percent: number): number {
  return Math.min(100, Math.max(0, Math.round(percent)))
}

/** Fill clockwise from 12 o’clock at glyph size. Butt caps avoid overstating short arcs. */
export function AgentProgressRing({
  percent,
  tone = 'working',
  label,
  className
}: {
  /** 0–100. */
  percent: number
  tone?: AgentProgressRingTone
  /** Accessible name; defaults to the bare percentage. */
  label?: string
  className?: string
}): React.JSX.Element {
  const clamped = clampPercent(percent)
  const arc = clamped === 0 ? 0 : Math.max(MIN_VISIBLE_PERCENT, clamped)
  return (
    <svg
      viewBox="0 0 16 16"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={clamped}
      aria-label={label ?? formatAgentProgressPercent(clamped)}
      data-agent-progress-ring=""
      className={cn(
        'block shrink-0 -rotate-90',
        tone === 'working' ? 'text-agent-working' : 'text-agent-question',
        className
      )}
    >
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.25}
        strokeWidth={3}
      />
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        stroke="currentColor"
        strokeWidth={3}
        pathLength={100}
        strokeDasharray={`${arc} 100`}
        className="transition-[stroke-dasharray] duration-500 ease-out motion-reduce:transition-none"
      />
    </svg>
  )
}

export function formatAgentProgressPercent(percent: number): string {
  return `${clampPercent(percent)}%`
}
