import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { ContextPressureIndicator } from './ContextPressureIndicator'

// Render tooltip content inline so assertions can see it without user events.
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => (
    <div data-tooltip-content="">{children}</div>
  ),
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

describe('ContextPressureIndicator', () => {
  it.each([
    ['ok', 'fill-emerald-500'],
    ['warning', 'fill-amber-500'],
    ['critical', 'fill-red-500']
  ] as const)('renders the %s level with its status color', (level, dotClass) => {
    const markup = renderToStaticMarkup(<ContextPressureIndicator level={level} usedPercent={50} />)
    expect(markup).toContain(`data-context-pressure="${level}"`)
    expect(markup).toContain(dotClass)
  })

  it('shows exact tokens, percent, and the limit source in the tooltip', () => {
    const markup = renderToStaticMarkup(
      <ContextPressureIndicator
        level="warning"
        usedPercent={75}
        usedTokens={150_000}
        limitTokens={200_000}
        limitSource="soft-cap"
      />
    )
    expect(markup).toContain('Context window: 150.0k of 200.0k tokens (75%)')
    expect(markup).toContain('Effective context limit: soft cap')
    expect(markup).toContain(
      'aria-label="Context window: 150.0k of 200.0k tokens (75%). Effective context limit: soft cap. approaching limit"'
    )
  })

  it('falls back to a percent-only tooltip when token detail is absent (pop-out snapshot)', () => {
    const markup = renderToStaticMarkup(
      <ContextPressureIndicator level="critical" usedPercent={95} />
    )
    expect(markup).toContain('Context window: 95% used')
    expect(markup).not.toContain('Effective context limit')
  })

  it('clamps out-of-range percents for display', () => {
    expect(
      renderToStaticMarkup(<ContextPressureIndicator level="critical" usedPercent={104.6} />)
    ).toContain('Context window: 100% used')
    expect(
      renderToStaticMarkup(<ContextPressureIndicator level="ok" usedPercent={-3} />)
    ).toContain('Context window: 0% used')
  })
})
