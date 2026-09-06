import React from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AgentStateDot, agentStateLabel, type AgentDotState } from './AgentStateDot'

vi.mock('@/components/StateIndicatorTooltip', async () => {
  const { createElement } = await import('react')
  return {
    StateIndicatorTooltip: ({
      label,
      children
    }: {
      label: string | null
      children: React.ReactElement
    }) =>
      label === null
        ? children
        : createElement('span', { 'data-state-indicator-tooltip': label }, children)
  }
})

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

  it('renders monitoring as a static yellow heartbeat glyph', () => {
    const markup = renderMarkup('monitoring')

    expect(markup).toContain('aria-label="Monitoring background tasks"')
    expect(markup).toContain('lucide-activity')
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

  it('renders unverifiable as an amber dashed ring, never the done check or the spinner', () => {
    const markup = renderMarkup('unverifiable')

    expect(markup).toContain('lucide-circle-dashed')
    expect(markup).toContain('text-amber-500')
    expect(markup).not.toContain('lucide-circle-check')
    expect(markup).not.toContain('data-agent-spinner')
  })

  it.each(['blocked', 'interrupted'] satisfies AgentDotState[])(
    'renders %s as a red attention dot',
    (state) => {
      const classNames = renderDotClassNames(state)

      expect(classNames).toContain('bg-red-500')
      expect(classNames).not.toContain('bg-amber-500')
    }
  )

  const ALL_STATES = [
    'working',
    'monitoring',
    'blocked',
    'waiting',
    'interrupted',
    'failed',
    'done',
    'idle',
    'unverifiable',
    'permission'
  ] satisfies AgentDotState[]

  it.each(ALL_STATES)('labels %s with the shared hover tooltip', (state) => {
    const markup = renderMarkup(state)

    expect(markup).toContain(`data-state-indicator-tooltip="${agentStateLabel(state)}"`)
    expect(markup).not.toContain(' title=')
  })

  // Typecheck-time guard: a new AgentDotState member that ALL_STATES omits
  // fails `pnpm tc`, so the tooltip case above can never silently skip a state.
  type UncoveredState = Exclude<AgentDotState, (typeof ALL_STATES)[number]>
  const _allStatesAreCovered: UncoveredState extends never ? true : never = true
  void _allStatesAreCovered

  it('lets a caller override the tooltip', () => {
    const markup = renderToStaticMarkup(
      React.createElement(AgentStateDot, { state: 'done', title: 'Finished 2m ago' })
    )

    expect(markup).toContain('data-state-indicator-tooltip="Finished 2m ago"')
    expect(markup).not.toContain(' title=')
    expect(markup).toContain('aria-label="Done"')
  })

  it('lets a caller with an existing tooltip suppress the shared tooltip', () => {
    const markup = renderToStaticMarkup(
      React.createElement(AgentStateDot, { state: 'interrupted', title: null })
    )

    expect(markup).not.toContain('data-state-indicator-tooltip')
    expect(markup).toContain('aria-label="Interrupted"')
    expect(renderMarkup('interrupted')).toContain(
      `data-state-indicator-tooltip="${agentStateLabel('interrupted')}"`
    )
  })
})
