import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { stubRpcClient } from '../../../transport/rpc-client-test-stub'
import { MobileNativeChatRowOverlaysContext } from './mobile-native-chat-row-overlays'

const readHostChatImage = vi.hoisted(() => vi.fn(async () => 'data:image/png;base64,thumb'))

vi.mock('react-native', () => ({
  Image: 'Image',
  Linking: { openURL: () => Promise.resolve() },
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))
vi.mock('../../../components/pr-sidebar/MermaidDiagram', () => ({
  MermaidDiagram: 'MermaidDiagram'
}))
vi.mock('../../../components/MobileSourceCopyButton', () => ({
  MobileSourceCopyButton: 'MobileSourceCopyButton'
}))
vi.mock('../visual/mobile-native-chat-image-preview', async () => {
  const actual = await vi.importActual<typeof import('../visual/mobile-native-chat-image-preview')>(
    '../visual/mobile-native-chat-image-preview'
  )
  return { ...actual, readHostChatImage }
})

import { Prose } from './MobileNativeChatProse'

const openImage = vi.fn()

function images(tree: ReactTestRenderer): ReactTestInstance[] {
  return tree.root.findAll((node) => {
    const source = node.props.source as { uri?: unknown } | undefined
    return typeof source?.uri === 'string'
  })
}

function render(text: string): ReactTestRenderer {
  let renderer: ReactTestRenderer | undefined
  act(() => {
    renderer = create(
      createElement(
        MobileNativeChatRowOverlaysContext.Provider,
        {
          value: {
            openImage,
            openActions: () => {},
            imageSource: { client: stubRpcClient(), worktreeId: 'worktree' }
          }
        },
        createElement(Prose, { block: { type: 'text', text }, text, fontScale: 1 })
      )
    )
  })
  return renderer!
}

describe('mobile chat markdown images', () => {
  afterEach(() => {
    openImage.mockClear()
    readHostChatImage.mockClear()
  })

  it('shows an absolute path through the host image read and opens it', async () => {
    const tree = render('![Shot](/tmp/shot.png)')
    await act(async () => {
      await readHostChatImage.mock.results[0]?.value
    })
    expect(readHostChatImage).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: 'worktree' }),
      '/tmp/shot.png',
      expect.any(AbortSignal)
    )
    const button = tree.root.findByProps({ accessibilityRole: 'imagebutton' })
    expect(images(tree)[0]?.props.source).toEqual({ uri: 'data:image/png;base64,thumb' })
    act(() => button.props.onPress())
    expect(openImage).toHaveBeenCalledWith({
      uri: 'data:image/png;base64,thumb',
      label: 'Shot'
    })
    act(() => tree.unmount())
  })

  it('shows an https image without a host read', () => {
    const tree = render('![Remote](https://example.com/shot.png)')
    expect(tree.root.findByProps({ accessibilityRole: 'imagebutton' })).toBeTruthy()
    expect(images(tree)[0]?.props.source).toEqual({
      uri: 'https://example.com/shot.png'
    })
    expect(readHostChatImage).not.toHaveBeenCalled()
    act(() => tree.unmount())
  })

  it.each([
    ['![Shot](/tmp/my%20shot.png)', '/tmp/my shot.png'],
    ['![Shot](C:\\shots\\shot.png)', 'C:\\shots\\shot.png'],
    ['![Shot](file:///C:/shots/my%20shot.png)', 'C:/shots/my shot.png'],
    ['![Shot](file://server/share/shot.png)', '//server/share/shot.png']
  ])('reads local image paths from %s', async (markdown, path) => {
    const tree = render(markdown)
    await act(async () => {
      await readHostChatImage.mock.results[0]?.value
    })
    expect(readHostChatImage).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: 'worktree' }),
      path,
      expect.any(AbortSignal)
    )
    act(() => tree.unmount())
  })

  it('leaves a relative image as a link', () => {
    const tree = render('![Notes](notes/shot.png)')
    expect(images(tree)).toHaveLength(0)
    expect(readHostChatImage).not.toHaveBeenCalled()
    act(() => tree.unmount())
  })

  it('shows stacked absolute images from one paragraph, including alt text with spaces', async () => {
    const tree = render(
      [
        "![The dev server's session list](/Users/eclipxe/.orca-qa/shots/30-host-session-list.png)",
        '![The session opened](/tmp/orca-real-session-tasks.png)',
        "![After the swipe: back on that server's session list](/tmp/shot.png)"
      ].join('\n')
    )
    await act(async () => {
      await Promise.all(readHostChatImage.mock.results.map((result) => result.value))
    })
    expect(readHostChatImage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ worktreeId: 'worktree' }),
      '/Users/eclipxe/.orca-qa/shots/30-host-session-list.png',
      expect.any(AbortSignal)
    )
    expect(readHostChatImage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ worktreeId: 'worktree' }),
      '/tmp/orca-real-session-tasks.png',
      expect.any(AbortSignal)
    )
    expect(readHostChatImage).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ worktreeId: 'worktree' }),
      '/tmp/shot.png',
      expect.any(AbortSignal)
    )
    expect(tree.root.findAllByProps({ accessibilityRole: 'imagebutton' })).toHaveLength(3)
    expect(
      tree.root.findAll(
        (node) =>
          typeof node.props.onPress === 'function' && node.props.accessibilityRole !== 'imagebutton'
      )
    ).toHaveLength(0)
    act(() => tree.unmount())
  })

  it('shows an absolute image beside a sentence instead of linking the alt text', async () => {
    const tree = render('See ![host list](/tmp/shot.png) here.')
    await act(async () => {
      await readHostChatImage.mock.results[0]?.value
    })
    expect(tree.root.findByProps({ accessibilityRole: 'imagebutton' })).toBeTruthy()
    expect(readHostChatImage).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: 'worktree' }),
      '/tmp/shot.png',
      expect.any(AbortSignal)
    )
    expect(
      tree.root.findAll(
        (node) =>
          typeof node.props.onPress === 'function' && node.props.accessibilityRole !== 'imagebutton'
      )
    ).toHaveLength(0)
    act(() => tree.unmount())
  })
})
