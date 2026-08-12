import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileMarkdown } from './MobileMarkdown'

vi.mock('react-native', () => ({
  Linking: { openURL: vi.fn() },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: <T>(styles: T) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))
vi.mock('./pr-sidebar/MermaidDiagram', () => ({ MermaidDiagram: 'MermaidDiagram' }))

let renderer: ReactTestRenderer | undefined

afterEach(() => {
  renderer?.unmount()
  renderer = undefined
  vi.restoreAllMocks()
})

function render(content: string): ReactTestRenderer {
  act(() => {
    renderer = create(createElement(MobileMarkdown, { content }))
  })
  return renderer!
}

function mermaidCount(tree: ReactTestRenderer): number {
  return tree.root.findAllByType('MermaidDiagram' as never).length
}

function firstMermaid(tree: ReactTestRenderer) {
  return tree.root.findByType('MermaidDiagram' as never)
}

describe('MobileMarkdown mermaid routing', () => {
  it('routes a closed mermaid fence to MermaidDiagram', () => {
    const tree = render('```mermaid\ngraph TD; A-->B\n```')
    expect(mermaidCount(tree)).toBe(1)
  })

  it('keeps a streaming (unterminated) mermaid fence as raw code', () => {
    const tree = render('```mermaid\ngraph TD; A-->B')
    expect(mermaidCount(tree)).toBe(0)
  })

  it('keeps identical sibling diagrams uniquely keyed', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const diagram = '```mermaid\ngraph TD; A-->B\n```'
    const tree = render(`${diagram}\n\n${diagram}`)
    const warnings = consoleError.mock.calls.flat().join(' ')
    expect(mermaidCount(tree)).toBe(2)
    expect(warnings).not.toContain('same key')
  })

  it('preserves a completed diagram while later prose streams', () => {
    const diagram = '```mermaid\ngraph TD; A-->B\n```'
    const tree = render(diagram)
    const initial = firstMermaid(tree)
    act(() => tree.update(createElement(MobileMarkdown, { content: `${diagram}\n\nNext` })))
    expect(firstMermaid(tree)).toBe(initial)
  })

  it('remounts a diagram when its source changes', () => {
    const tree = render('```mermaid\ngraph TD; A-->B\n```')
    const initial = firstMermaid(tree)
    act(() =>
      tree.update(createElement(MobileMarkdown, { content: '```mermaid\ngraph TD; A-->C\n```' }))
    )
    expect(firstMermaid(tree)).not.toBe(initial)
  })

  it('does not route other code fences to MermaidDiagram', () => {
    const tree = render('```ts\nconst a = 1\n```')
    expect(mermaidCount(tree)).toBe(0)
  })
})
