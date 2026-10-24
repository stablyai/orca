vi.mock('lucide-react-native', () => ({ Check: 'Check', Copy: 'Copy' }))
vi.mock('../platform/clipboard', () => ({
  useClipboardWriter: () => ({ writeText: async () => {} })
}))
import { createElement } from 'react'
import { act, create, type ReactTestInstance } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  ScrollView: 'ScrollView',
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 }
}))
vi.mock('./pr-sidebar/MermaidDiagram', () => ({ MermaidDiagram: () => null }))
import { MobileMarkdown } from './MobileMarkdown'
function text(node: ReactTestInstance): string {
  return node.children.map((child) => (typeof child === 'string' ? child : text(child))).join('')
}
function flat(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) {
    return Object.assign({}, ...value.map(flat))
  }
  return typeof value === 'object' && value !== null ? { ...value } : {}
}
it('scales headings, prose, lists, tables and fenced code together and retains inline characters', () => {
  let tree!: ReturnType<typeof create>
  act(() => {
    tree = create(
      createElement(MobileMarkdown, {
        textScale: 1.25,
        rangeSelectable: true,
        content:
          '# Heading\n\nRead `src/a.ts` now.\n\n> Quoted\n\n- Listed\n\n```ts\nconst value = 1\n```\n\n| A |\n| --- |\n| Cell |'
      })
    )
  })
  try {
    const nodes = tree.root.findAll((node) => String(node.type) === 'Text')
    const style = (value: string) => flat(nodes.find((node) => text(node) === value)!.props.style)
    expect(style('Heading').fontSize).toBeGreaterThan(Number(style('Read src/a.ts now.').fontSize))
    expect(style('Quoted').fontSize).toBe(16.25)
    expect(style('Listed').fontSize).toBe(16.25)
    expect(style('Cell').fontSize).toBe(15)
    expect(style('const value = 1').fontSize).toBe(15)
    expect(style('src/a.ts').fontSize).toBe(14.625)
    expect(nodes.find((node) => text(node) === 'Read src/a.ts now.')!.props.selectable).toBe(true)
    const code = nodes.find((node) => text(node) === 'const value = 1')!
    let parent = code.parent
    while (parent && !parent.props.horizontal) {
      parent = parent.parent
    }
    expect(parent?.props.horizontal).toBe(true)
  } finally {
    act(() => tree.unmount())
  }
})
