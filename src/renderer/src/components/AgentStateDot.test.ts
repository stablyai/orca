import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AgentStateDot, type AgentDotState } from './AgentStateDot'

function renderMarkup(state: AgentDotState): string {
  return renderToStaticMarkup(React.createElement(AgentStateDot, { state }))
}

function renderDotClassNames(state: AgentDotState): string[] {
  const markup = renderMarkup(state)
  const dotClassName = markup.match(/<span class="([^"]*rounded-full[^"]*)"/)?.[1]

  expect(dotClassName).toBeDefined()

  return dotClassName!.split(/\s+/)
}

describe('AgentStateDot', () => {
  it('renders working with the semantic working spinner', () => {
    const markup = renderMarkup('working')

    expect(markup).toContain('border-status-working')
    expect(markup).toContain('border-t-transparent')
    expect(markup).toContain('[animation:spin_1s_steps(12,end)_infinite]')
    expect(markup).toContain('motion-reduce:animate-none')
    expect(markup).not.toContain('animate-spin')
  })

  it('renders done as an emerald check icon', () => {
    const markup = renderMarkup('done')

    // Why: 'done' renders a CircleCheck icon rather than a dot so it is
    // visually distinct from other emerald-adjacent states across surfaces.
    // Note: the sidebar's StatusIndicator intentionally diverges and uses an
    // emerald dot for 'done'. Assertion targets the lucide 'circle-check'
    // class hook + emerald text color, identifying the check icon without
    // coupling to the exact SVG path markup lucide emits.
    expect(markup).toContain('lucide-circle-check')
    expect(markup).toContain('text-status-success')
  })

  it.each(['permission', 'waiting'] satisfies AgentDotState[])(
    'renders %s as an amber attention dot',
    (state) => {
      const classNames = renderDotClassNames(state)

      expect(classNames).toContain('bg-status-attention')
      expect(classNames).not.toContain('bg-destructive')
    }
  )

  it.each(['blocked', 'interrupted'] satisfies AgentDotState[])(
    'renders %s as a red attention dot',
    (state) => {
      const classNames = renderDotClassNames(state)

      expect(classNames).toContain('bg-destructive')
      expect(classNames).not.toContain('bg-status-attention')
    }
  )

  it('renders idle with the theme-aware muted foreground', () => {
    expect(renderDotClassNames('idle')).toContain('bg-muted-foreground')
  })

  it('supports one caller-owned accessible label without duplicating it', () => {
    const markup = renderToStaticMarkup(
      React.createElement(AgentStateDot, {
        state: 'interrupted',
        'aria-label': 'Interrupted by user'
      })
    )

    expect(markup.match(/aria-label=/g)).toHaveLength(1)
    expect(markup).toContain('role="img"')
    expect(markup).toContain('aria-label="Interrupted by user"')
    expect(markup).not.toContain('aria-label="Interrupted"')
  })

  it('can be hidden when adjacent text already owns the state label', () => {
    const markup = renderToStaticMarkup(
      React.createElement(AgentStateDot, { state: 'done', 'aria-hidden': 'true' })
    )

    expect(markup).toContain('aria-hidden="true"')
    expect(markup).not.toContain('role="img"')
    expect(markup).not.toContain('aria-label=')
  })
})
