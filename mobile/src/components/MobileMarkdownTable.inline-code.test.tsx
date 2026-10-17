import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { MobileMarkdown } from './MobileMarkdown'
import { applyMobileColorScheme, colors } from '../theme/mobile-theme'

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  Linking: { openURL: async () => {} },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  Text: 'Text',
  View: 'View',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 }
}))
vi.mock('./pr-sidebar/MermaidDiagram', () => ({ MermaidDiagram: 'MermaidDiagram' }))
vi.mock('../platform/clipboard', () => ({
  useClipboardWriter: () => ({ writeText: async () => {} })
}))
vi.mock('lucide-react-native', () => ({ Check: 'Check', Copy: 'Copy' }))
let renderer: ReactTestRenderer | undefined
afterEach(() => {
  act(() => renderer?.unmount())
  applyMobileColorScheme('dark')
})
function background(style: unknown): unknown {
  if (Array.isArray(style)) {
    return style.map(background).findLast((value) => value !== undefined)
  }
  if (style && typeof style === 'object' && 'backgroundColor' in style) {
    return style.backgroundColor
  }
  return undefined
}
it.each(['light', 'dark'] as const)(
  'distinguishes header and body inline code in %s and after switching themes',
  (scheme) => {
    applyMobileColorScheme(scheme)
    act(() => {
      renderer = create(
        createElement(MobileMarkdown, { content: '| `Header` |\n| --- |\n| `Body` |' })
      )
    })
    const check = () => {
      const codes = renderer!.root.findAll(
        (node) =>
          String(node.type) === 'Text' &&
          ['Header', 'Body'].includes(node.props.children) &&
          background(node.props.style) !== undefined
      )
      expect(codes).toHaveLength(2)
      expect(background(codes[0]!.props.style)).toBe(colors.bgBase)
      expect(background(codes[1]!.props.style)).toBe(colors.bgRaised)
    }
    check()
    act(() => applyMobileColorScheme(scheme === 'dark' ? 'light' : 'dark'))
    check()
  }
)

it.each(['light', 'dark'] as const)('distinguishes code chips from quoted text in %s', (scheme) => {
  applyMobileColorScheme(scheme)
  act(() => {
    renderer = create(createElement(MobileMarkdown, { content: '> `Quoted code`' }))
  })
  const code = renderer!.root.find(
    (node) => String(node.type) === 'Text' && node.props.children === 'Quoted code'
  )
  const quote = renderer!.root.find(
    (node) => String(node.type) === 'View' && node.props.style?.borderLeftWidth === 2
  )
  expect(background(code.props.style)).toBe(colors.bgRaised)
  expect(quote.props.style.backgroundColor).toBe(colors.bgPanel)
  expect(background(code.props.style)).not.toBe(quote.props.style.backgroundColor)
})
