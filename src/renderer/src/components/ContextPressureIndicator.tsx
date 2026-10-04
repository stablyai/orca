import React from 'react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { formatTokens } from '@/components/stats/usage-formatters'
import { clampUsedPercent } from '../../../shared/usage-percentage-display'
import { Circle, Diamond, Triangle } from 'lucide-react'
import type {
  AgentContextUsage,
  ContextPressureLevel,
  ContextPressureLimitSource
} from '../../../shared/agent-context-pressure'

// Unknown pressure renders nothing; known levels reuse the agent-state palette.

const LEVEL_DOT_CLASS: Record<ContextPressureLevel, string> = {
  ok: 'fill-emerald-500 text-emerald-500',
  warning: 'fill-amber-500 text-amber-500',
  critical: 'fill-red-500 text-red-500'
}

/** Translated label for which candidate bound the effective context limit. */
export function contextPressureLimitSourceLabel(source: ContextPressureLimitSource): string {
  switch (source) {
    case 'provider':
      return translate(
        'auto.components.ContextPressureIndicator.sourceProvider',
        'provider-reported'
      )
    case 'model':
      return translate('auto.components.ContextPressureIndicator.sourceModel', 'model maximum')
    case 'soft-cap':
      return translate('auto.components.ContextPressureIndicator.sourceSoftCap', 'soft cap')
  }
}

type Props = {
  level: ContextPressureLevel
  /** Raw percent of the effective limit; clamped to 0-100 for display. */
  usedPercent: number
  // Token detail is optional: the dashboard pop-out snapshot carries only
  // level + percent, so its tooltip omits the exact-token line.
  usedTokens?: number
  limitTokens?: number
  limitSource?: ContextPressureLimitSource
  usedTokensSource?: AgentContextUsage['usedTokensSource']
  size?: 'sm' | 'md'
  tooltipSide?: 'top' | 'right' | 'bottom'
  className?: string
}

// Matches each surface's neighboring tooltips (tab strip 6, sidebar right 8).
const TOOLTIP_SIDE_OFFSET: Record<'top' | 'right' | 'bottom', number> = {
  top: 4,
  right: 8,
  bottom: 6
}

/** Traffic-light context-window usage dot with an exact-values tooltip. */
export const ContextPressureIndicator = React.memo(function ContextPressureIndicator({
  level,
  usedPercent,
  usedTokens,
  limitTokens,
  limitSource,
  usedTokensSource,
  size = 'sm',
  tooltipSide = 'top',
  className
}: Props): React.JSX.Element {
  const box = size === 'md' ? 'h-3 w-3' : 'h-2.5 w-2.5'
  const inner = size === 'md' ? 'size-2' : 'size-1.5'
  const percent = clampUsedPercent(usedPercent)
  const usageLine =
    usedTokens !== undefined && limitTokens !== undefined
      ? translate(
          'auto.components.ContextPressureIndicator.usageDetail',
          'Context window: {{value0}}{{value1}} of {{value2}} tokens ({{value3}}%)',
          {
            value0: usedTokensSource === 'derived-percent' ? '≈' : '',
            value1: formatTokens(usedTokens),
            value2: formatTokens(limitTokens),
            value3: percent
          }
        )
      : translate(
          'auto.components.ContextPressureIndicator.usagePercent',
          'Context window: {{value0}}% used',
          { value0: percent }
        )
  const sourceLine =
    limitSource === undefined
      ? ''
      : translate(
          'auto.components.ContextPressureIndicator.limitSource',
          'Effective context limit: {{value0}}',
          { value0: contextPressureLimitSourceLabel(limitSource) }
        )
  const levelLabel =
    level === 'ok'
      ? translate('auto.components.ContextPressureIndicator.levelOk', 'healthy')
      : level === 'warning'
        ? translate('auto.components.ContextPressureIndicator.levelWarning', 'approaching limit')
        : translate('auto.components.ContextPressureIndicator.levelCritical', 'near limit')
  const accessibilityLabel = [usageLine, sourceLine, levelLabel].filter(Boolean).join('. ')
  const LevelIcon = level === 'ok' ? Circle : level === 'warning' ? Triangle : Diamond

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn('inline-flex shrink-0 items-center justify-center', box, className)}
          data-context-pressure={level}
          role="img"
          aria-label={accessibilityLabel}
        >
          <LevelIcon aria-hidden="true" className={cn(inner, LEVEL_DOT_CLASS[level])} />
        </span>
      </TooltipTrigger>
      <TooltipContent side={tooltipSide} sideOffset={TOOLTIP_SIDE_OFFSET[tooltipSide]}>
        <div className="flex flex-col gap-0.5">
          <span>{usageLine}</span>
          {sourceLine && <span>{sourceLine}</span>}
          {usedTokensSource === 'derived-percent' && (
            <span>
              {translate(
                'auto.components.ContextPressureIndicator.derivedUsage',
                'Token usage derived from a provider-reported percentage'
              )}
            </span>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  )
})
