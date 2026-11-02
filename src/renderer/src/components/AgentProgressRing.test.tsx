import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AgentProgressRing, formatAgentProgressPercent } from './AgentProgressRing'
import { AgentStateDot, agentStateProgressLabel } from './AgentStateDot'

describe('AgentProgressRing', () => {
  it('exposes the percentage as a progressbar and fills the arc to it', () => {
    const markup = renderToStaticMarkup(<AgentProgressRing percent={42.4} />)
    expect(markup).toContain('role="progressbar"')
    expect(markup).toContain('aria-valuenow="42"')
    expect(markup).toContain('stroke-dasharray="42 100"')
  })

  it('keeps a tiny percentage visible but draws nothing at zero', () => {
    expect(renderToStaticMarkup(<AgentProgressRing percent={1} />)).toContain(
      'stroke-dasharray="8 100"'
    )
    expect(renderToStaticMarkup(<AgentProgressRing percent={0} />)).toContain(
      'stroke-dasharray="0 100"'
    )
  })

  it('takes an accessible name over the bare percentage', () => {
    expect(
      renderToStaticMarkup(<AgentProgressRing percent={42} label="Working · 42%" />)
    ).toContain('aria-label="Working · 42%"')
  })

  it('clamps the label to 0–100', () => {
    expect(formatAgentProgressPercent(140)).toBe('100%')
    expect(formatAgentProgressPercent(-3)).toBe('0%')
  })
})

describe('AgentStateDot with program progress', () => {
  const render = (state: Parameters<typeof AgentStateDot>[0]['state'], progress?: number) =>
    renderToStaticMarkup(
      <TooltipProvider>
        <AgentStateDot state={state} progress={progress} />
      </TooltipProvider>
    )

  it('swaps the spinner for a filling ring while working, announced once on the progressbar', () => {
    const markup = render('working', 60)
    expect(markup).toContain('data-agent-progress-ring')
    expect(markup).not.toContain('data-agent-spinner')
    expect(markup).toContain('text-agent-working')
    expect(markup.match(/aria-label="Working · 60%"/g)).toHaveLength(1)
    expect(markup).toMatch(/<svg[^>]*role="progressbar"[^>]*aria-label="Working · 60%"/)
  })

  it('draws the ring in the attention tone for every attention state', () => {
    for (const state of ['waiting', 'blocked', 'permission'] as const) {
      expect(render(state, 30)).toContain('text-agent-question')
    }
  })

  it('ignores progress on finished states', () => {
    expect(render('done', 100)).not.toContain('data-agent-progress-ring')
    expect(render('working')).toContain('data-agent-spinner')
  })
})

describe('agentStateProgressLabel', () => {
  it('adds the percentage only where the dot draws a ring', () => {
    expect(agentStateProgressLabel('working', 42)).toBe('Working · 42%')
    expect(agentStateProgressLabel('waiting', 42)).toBe('Waiting for input · 42%')
    expect(agentStateProgressLabel('done', 42)).toBe('Done')
    expect(agentStateProgressLabel('working', undefined)).toBe('Working')
  })

  it('decorates a caller-supplied label', () => {
    expect(agentStateProgressLabel('working', 7, 'Compiling')).toBe('Compiling · 7%')
    expect(agentStateProgressLabel('unverifiable', 7, 'No update in 3m')).toBe('No update in 3m')
  })
})
