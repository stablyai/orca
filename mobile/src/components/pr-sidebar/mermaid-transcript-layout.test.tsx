import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { MobileTranscriptLayoutContext } from '../mobile-transcript-layout'

const { render } = vi.hoisted(() => ({ render: vi.fn() }))
vi.mock('./mermaid-page-engine.generated', () => ({ default: { initialize: vi.fn(), render } }))
vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 }
}))
import { MermaidDiagram } from './MermaidDiagram'

it('holds the first transcript layout until the page diagram has rendered', async () => {
  let complete: (value: { svg: string }) => void = () => {}
  const pending = new Promise<{ svg: string }>((resolve) => {
    complete = resolve
  })
  render.mockReturnValueOnce(pending)
  const release = vi.fn(),
    register = vi.fn(() => release)
  const host = { innerHTML: '', replaceChildren: vi.fn() }
  let tree!: ReturnType<typeof create>
  act(() => {
    tree = create(
      createElement(
        MobileTranscriptLayoutContext.Provider,
        { value: register },
        createElement(MermaidDiagram, { source: 'flowchart TD\nA-->B', base: 13 })
      ),
      { createNodeMock: () => host }
    )
  })
  try {
    expect(register).toHaveBeenCalledOnce()
    expect(release).not.toHaveBeenCalled()
    await act(async () => {
      await vi.waitFor(() => expect(render).toHaveBeenCalledOnce())
      complete({ svg: '<svg>ready</svg>' })
      await pending
    })
    expect(host.innerHTML).toBe('<svg>ready</svg>')
    expect(release).toHaveBeenCalledOnce()
  } finally {
    act(() => tree.unmount())
  }
})
