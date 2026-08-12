import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileAgentIcon } from './MobileAgentIcon'

vi.mock('react-native', () => ({
  Image: 'Image',
  StyleSheet: { create: (styles: unknown) => styles },
  Text: 'Text',
  View: 'View'
}))

vi.mock('lucide-react-native', () => ({
  Terminal: 'Terminal'
}))

vi.mock('react-native-svg', () => ({
  default: 'Svg',
  Defs: 'Defs',
  G: 'G',
  LinearGradient: 'LinearGradient',
  Path: 'Path',
  Stop: 'Stop'
}))

vi.mock('./mobile-agent-icon-assets', () => ({
  MOBILE_AGENT_ICON_ASSETS: {}
}))

vi.mock('./AgentIcons', () => ({
  ClaudeIcon: 'ClaudeIcon',
  OpenAIIcon: 'OpenAIIcon'
}))

describe('MobileAgentIcon OMP gradient', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.restoreAllMocks()
  })

  it('uses valid SVG gradient stop offsets', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args) => {
      if (typeof args[0] !== 'string' || !args[0].includes('react-test-renderer is deprecated')) {
        throw new Error(String(args[0]))
      }
    })
    await act(async () => {
      renderer = create(createElement(MobileAgentIcon, { agentId: 'omp' }))
    })
    consoleError.mockRestore()

    expect(renderer.root.findAllByType('Stop').map((stop) => stop.props.offset)).toEqual([
      '0',
      '0.5',
      '1'
    ])
  })
})
