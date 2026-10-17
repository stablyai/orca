import { createElement } from 'react'
import { act, create, type ReactTestInstance } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  ScrollView: 'ScrollView',
  Pressable: 'Pressable',
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 }
}))
vi.mock('lucide-react-native', () => ({ ChevronDown: 'ChevronDown', ChevronRight: 'ChevronRight' }))
vi.mock('../MobileMarkdownCodeBlock', () => ({ MobileMarkdownCodeBlock: () => null }))
vi.mock('./MermaidDiagram', () => ({ MermaidDiagram: () => null }))
vi.mock('../../platform/external-link', () => ({ openExternalLink: vi.fn() }))
import { CommentMarkdown } from './CommentMarkdown'
import { applyMobileColorScheme, colors } from '../../theme/mobile-theme'
function flat(value: unknown): Record<string, unknown> {
  return Array.isArray(value)
    ? Object.assign({}, ...value.map(flat))
    : typeof value === 'object' && value !== null
      ? { ...value }
      : {}
}
function surfaceAncestors(node: ReactTestInstance): unknown[] {
  const surfaces: unknown[] = []
  let parent = node.parent
  while (parent) {
    const background = flat(parent.props.style).backgroundColor
    if (background) {
      surfaces.push(background)
    }
    parent = parent.parent
  }
  return surfaces
}
it.each(['light', 'dark'] as const)(
  'distinguishes inline code from quote and header surfaces in %s mode',
  (scheme) => {
    applyMobileColorScheme(scheme)
    let tree!: ReturnType<typeof create>
    act(() => {
      tree = create(
        createElement(CommentMarkdown, {
          content: '> Use `quoteCode`.\n\n| `headerCode` |\n| --- |\n| Value |'
        })
      )
    })
    try {
      for (const label of ['quoteCode', 'headerCode']) {
        const code = tree.root.findAll(
          (node) => String(node.type) === 'Text' && node.children.join('') === label
        )[0]
        expect(flat(code.props.style).backgroundColor).toBe(colors.bgRaised)
        expect(surfaceAncestors(code)).toContain(colors.bgPanel)
        expect(colors.bgPanel).not.toBe(colors.bgRaised)
      }
    } finally {
      act(() => tree.unmount())
      applyMobileColorScheme('dark')
    }
  }
)
