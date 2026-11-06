import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MobileMarkdown } from './MobileMarkdown'
import { MarkdownLinkHandlerContext } from './markdown-link-handler'

const openURL = vi.fn((_url: string) => Promise.resolve())

vi.mock('react-native', () => ({
  Linking: { openURL: (url: string) => openURL(url) },
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))
vi.mock('./pr-sidebar/MermaidDiagram', () => ({ MermaidDiagram: 'MermaidDiagram' }))
vi.mock('./MobileSourceCopyButton', () => ({ MobileSourceCopyButton: 'MobileSourceCopyButton' }))

let renderer: ReactTestRenderer | null = null

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
  openURL.mockClear()
})

function render(content: string, growing = false): ReactTestRenderer {
  act(() => {
    renderer = create(createElement(MobileMarkdown, { content, growing }))
  })
  return renderer!
}

function flatten(node: ReactTestInstance | string): string {
  return typeof node === 'string' ? node : node.children.map(flatten).join('')
}

const isText = (node: ReactTestInstance): boolean => String(node.type) === 'Text'

/** Every Text not inside another Text, in reading order: what the reader sees, block by block. */
function texts(tree: ReactTestRenderer): string[] {
  return tree.root
    .findAll((node) => isText(node) && !(node.parent && hasTextAncestor(node.parent)))
    .map(flatten)
}

function hasTextAncestor(node: ReactTestInstance): boolean {
  return isText(node) || (node.parent !== null && hasTextAncestor(node.parent))
}

function press(tree: ReactTestRenderer, label: string): void {
  const target = tree.root.find(
    (node) => isText(node) && typeof node.props.onPress === 'function' && flatten(node) === label
  )
  act(() => target.props.onPress())
}

describe('MobileMarkdown rendering', () => {
  it('C21: closes open markup while a reply grows, and never links a half-written address', () => {
    expect(texts(render('2 * 3 is six.\n\nRead **src/main/ses', true))).toEqual([
      '2 * 3 is six.',
      'Read src/main/ses'
    ])
    const tree = render('See [config loader](https://exa', true)
    expect(texts(tree)).toEqual(['See config loader'])
    expect(tree.root.findAll((node) => typeof node.props.onPress === 'function')).toEqual([])
  })

  it('hands a web link to the screen that offers choices; mail and file links still open directly', () => {
    const onOpenLink = vi.fn()
    const onOpenFile = vi.fn()
    act(() => {
      renderer = create(
        createElement(
          MarkdownLinkHandlerContext.Provider,
          { value: onOpenLink },
          createElement(MobileMarkdown, {
            content: '[docs](https://x.com/a), [mail](mailto:a@x.com) and [file](src/a.ts)',
            onOpenFile
          })
        )
      )
    })
    press(renderer!, 'docs')
    press(renderer!, 'mail')
    press(renderer!, 'file')

    expect(onOpenLink).toHaveBeenCalledTimes(1)
    expect(onOpenLink).toHaveBeenCalledWith('https://x.com/a')
    expect(openURL).toHaveBeenCalledTimes(1)
    expect(openURL).toHaveBeenCalledWith('mailto:a@x.com')
    expect(onOpenFile).toHaveBeenCalledWith('src/a.ts')
  })
})

it('draws every image in a paragraph and keeps the text around them, leaving declined images as links', () => {
  const renderImage = vi.fn((href: string, alt: string) =>
    href.startsWith('/') ? createElement('View', { testID: `image:${href}`, alt }) : null
  )
  act(() => {
    renderer = create(
      createElement(MobileMarkdown, {
        content:
          'Before and after:  \n![one](/tmp/a.png)\n![two](/tmp/b.png)\n![three](rel.png) done',
        renderImage
      })
    )
  })
  const images = renderer!.root.findAll((node) => String(node.props.testID).startsWith('image:'))
  expect(images.map((node) => node.props.testID)).toEqual(['image:/tmp/a.png', 'image:/tmp/b.png'])
  expect(texts(renderer!)).toEqual(['Before and after:', 'three done'])
})
