import React from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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
  it('keeps the question glyph above the light-theme non-text contrast floor', () => {
    const css = readFileSync(join(__dirname, '../assets/main.css'), 'utf8')
    const lightTheme = css.match(/:root\s*\{(?<body>[\s\S]*?)\n\}/)?.groups?.body
    const darkTheme = css.match(/\.dark\s*\{(?<body>[\s\S]*?)\n\}/)?.groups?.body

    expect(lightTheme).toContain('--agent-question: var(--color-orange-600)')
    expect(darkTheme).toContain('--agent-question: var(--color-orange-500)')
  })

  it('renders working as a yellow spinner', () => {
    const markup = renderMarkup('working')

    expect(markup).toContain('border-yellow-500')
    expect(markup).toContain('border-t-transparent')
    // Why: rotation must come from the compositor-driven CSS animation, not a
    // JS clock writing per-element styles on the input thread (STA-3328).
    expect(markup).toContain('agent-working-spinner')
    expect(markup).toContain('data-agent-spinner')
    // Why: under reduced motion the top border is filled so the static ring
    // reads as a complete marker, not a broken partial spinner (#9515).
    expect(markup).toContain('motion-reduce:border-t-yellow-500')
  })

  it('renders monitoring as a static yellow radio glyph', () => {
    const markup = renderMarkup('monitoring')

    expect(markup).toContain('aria-label="Monitoring background tasks"')
    expect(markup).toContain('lucide-radio')
    expect(markup).toContain('text-yellow-500')
    expect(markup).not.toContain('data-agent-spinner')
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
    expect(markup).toContain('text-emerald-500')
  })

  it.each(['permission', 'waiting'] satisfies AgentDotState[])(
    'renders %s as the shared question glyph',
    (state) => {
      const markup = renderMarkup(state)

      expect(markup).toContain('lucide-message-circle-question-mark')
      // One token across sidebar, tabs, dashboard and map — never a raw hue.
      expect(markup).toContain('text-agent-question')
      expect(markup).not.toContain('text-amber-500')
      expect(markup).not.toContain('data-agent-spinner')
    }
  )

  it.each(['blocked', 'interrupted'] satisfies AgentDotState[])(
    'renders %s as a red attention dot',
    (state) => {
      const classNames = renderDotClassNames(state)

      expect(classNames).toContain('bg-red-500')
      expect(classNames).not.toContain('bg-amber-500')
    }
  )
})
