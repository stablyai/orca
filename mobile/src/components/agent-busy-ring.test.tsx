import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AgentSpinner } from './AgentSpinner'
import { AgentStateDot } from './AgentStateDot'
import { busyRingColors } from './agent-busy-ring'

// Renders the real components through react-native-web, which is what the hybrid WebView loads.
vi.mock('react-native', async () => await import('react-native-web'))
vi.mock('lucide-react-native', () => ({ Activity: () => null }))

const TRANSPARENT = 'rgba(0,0,0,0.00)'

function inlineStyle(markup: string): string {
  return markup.match(/style="([^"]*)"/)?.[1] ?? ''
}

describe('busy spinner ring on react-native-web', () => {
  it('puts the transparent gap after the ring color', () => {
    expect(Object.keys(busyRingColors('#eab308'))).toEqual(['borderColor', 'borderTopColor'])
  })

  it('leaves the worktree spinner top edge transparent', () => {
    const style = inlineStyle(
      renderToStaticMarkup(createElement(AgentSpinner, { status: 'working' }))
    )
    expect(style).toContain(`border-top-color:${TRANSPARENT}`)
    expect(style).toContain('border-right-color:rgba(234,179,8,1.00)')
  })

  it('leaves the agent state dot top edge transparent', () => {
    const style = inlineStyle(
      renderToStaticMarkup(createElement(AgentStateDot, { state: 'working' }))
    )
    expect(style).toContain(`border-top-color:${TRANSPARENT}`)
    expect(style).toContain('border-right-color:rgba(234,179,8,1.00)')
  })
})
