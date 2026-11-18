import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { TextStyle } from 'react-native'
import { slackMarkupShownText } from '../../../../src/shared/connectors/slack-message-markup'

vi.mock('react-native', async () => {
  const React = await import('react')
  const Text = ({ children, ...props }: { children?: ReactNode }): ReactNode =>
    React.createElement('Text', props, children)
  return {
    Image: 'Image',
    Platform: { OS: 'ios' },
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    Text,
    View: ({ children, ...props }: { children?: ReactNode }) =>
      React.createElement('View', props, children),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Animated: { Value: class {}, timing: () => ({ start: vi.fn() }) }
  }
})
vi.mock('lucide-react-native', () => ({ Square: 'Square', SquareCheck: 'SquareCheck' }))
vi.mock('../mermaid/MermaidDiagram', () => ({ MermaidDiagram: 'MermaidDiagram' }))
vi.mock('./math/MobileMarkdownMath', () => ({ MobileMarkdownMath: 'MobileMarkdownMath' }))
vi.mock('./blocks/MobileMarkdownCodeBlock', () => ({
  MobileMarkdownCodeBlock: 'MobileMarkdownCodeBlock'
}))
vi.mock('./blocks/MobileMarkdownRemoteImage', () => ({
  MobileMarkdownRemoteImage: 'MobileMarkdownRemoteImage'
}))
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }))

import { MobileMarkdown } from './MobileMarkdown'
import { MarkdownLinkHandlerContext } from './links/markdown-link-handler'
import { styles } from './mobile-markdown-styles'

function textOf(node: ReactTestInstance | string): string {
  return typeof node === 'string' ? node : node.children.map(textOf).join('')
}

// The mocked Text renders a host element named `Text`, outside React's intrinsic element names.
function isHostText(type: unknown): boolean {
  return type === 'Text'
}

function hasStyle(node: ReactTestInstance, style: TextStyle): boolean {
  const own: unknown = node.props.style
  return Array.isArray(own) ? own.flat(3).includes(style) : own === style
}

describe("a Slack message's markup on the phone", () => {
  it('draws mentions as mentions and links as links that open through the chat', () => {
    const shown = slackMarkupShownText(
      '<@U1|Ann (PM) *x*> <@U2> in <#C1|general> <!here> see <https://x.dev|the doc>; ' +
        'mail ann@Ann.dev, `@Ann (PM) *x*`'
    )
    const onOpenLink = vi.fn()
    let tree: ReactTestRenderer | undefined
    act(() => {
      tree = create(
        createElement(
          MarkdownLinkHandlerContext.Provider,
          { value: onOpenLink },
          createElement(MobileMarkdown, { content: shown!.markdown, slackMentions: true })
        )
      )
    })
    const spans = tree!.root.findAll((node) => isHostText(node.type))
    expect(spans.filter((node) => hasStyle(node, styles.mention)).map(textOf)).toEqual([
      '@Ann (PM) *x*',
      '#general',
      '@here'
    ])
    expect(spans.some((node) => hasStyle(node, styles.italic))).toBe(false)
    const link = spans.find((node) => hasStyle(node, styles.link) && textOf(node) === 'the doc')
    act(() => link?.props.onPress())
    expect(onOpenLink).toHaveBeenCalledWith('https://x.dev')
    const all = textOf(tree!.root)
    expect(all).toContain('@user in')
    expect(all).toContain('@Ann (PM) *x*')
    expect(all).toContain('mail ann@Ann.dev')
  })
})
