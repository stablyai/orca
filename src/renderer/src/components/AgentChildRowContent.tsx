import React from 'react'
import type { AgentChildRowModel } from '../../../shared/agent-child-row-model'
import { AgentStateDot } from '@/components/AgentStateDot'
import type { StateIndicatorTooltipSide } from '@/components/StateIndicatorTooltip'
import { agentChildRowText } from './agent-child-row-text'

type AgentChildRowContentProps = {
  row: AgentChildRowModel
  now: number
  /** Surface tone for the name and the detail; the words themselves are the row's. */
  leadClassName: string
  trailClassName: string
  separator: string
  /** Overrides the dot's hover label; null suppresses it for an existing tooltip. */
  dotTitle?: string | null
  tooltipSide?: StateIndicatorTooltipSide
  /** Name the whole line on hover, for surfaces that truncate it tightly. */
  lineTitle?: boolean
}

/**
 * A child row's state dot, name and detail: the one piece the sidebar's child rows and the chat
 * strip's rows both render, so the same child reads the same on both.
 */
export const AgentChildRowContent = React.memo(function AgentChildRowContent({
  row,
  now,
  leadClassName,
  trailClassName,
  separator,
  dotTitle,
  tooltipSide,
  lineTitle = false
}: AgentChildRowContentProps): React.JSX.Element {
  const { lead, trail } = agentChildRowText(row, now)
  return (
    <>
      <AgentStateDot
        state={row.displayState}
        size="sm"
        title={dotTitle}
        tooltipSide={tooltipSide}
      />
      <span
        className="min-w-0 flex-1 truncate"
        title={lineTitle ? `${lead}${trail ? `${separator}${trail}` : ''}` : undefined}
      >
        <span className={leadClassName}>{lead}</span>
        {trail ? (
          <span className={trailClassName}>
            {separator}
            {trail}
          </span>
        ) : null}
      </span>
    </>
  )
})
