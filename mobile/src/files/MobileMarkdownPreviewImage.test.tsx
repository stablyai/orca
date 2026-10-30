import { createElement } from 'react'
import type { ImageProps } from 'react-native'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { MobileMarkdownPreviewImage } from './MobileMarkdownPreviewImage'

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Image: Object.assign((props: ImageProps) => createElement('Image', props), {
    getSize: (_uri: string, loaded: (width: number, height: number) => void) => loaded(600, 220)
  }),
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles },
  Text: 'Text',
  View: 'View'
}))
vi.mock('../components/MobileLoadErrorState', () => ({ MobileLoadErrorState: 'LoadError' }))
vi.mock('../session/native-chat/visual/MobileNativeChatImageViewer', () => ({
  MobileNativeChatImageViewer: 'ImageViewer'
}))
const loader = vi.hoisted(() => vi.fn())
vi.mock('./mobile-markdown-image-source', () => ({ loadMarkdownPreviewImage: loader }))
let tree: ReactTestRenderer | null = null
afterEach(() => {
  act(() => tree?.unmount())
  tree = null
  vi.resetAllMocks()
})
const props = {
  client: null,
  worktreeId: 'wt',
  documentPath: 'notes.md',
  href: 'a.png',
  alt: 'Architecture'
}

it('shows the loaded image and expands it in the existing image viewer', async () => {
  loader.mockResolvedValue('data:image/png;base64,cG5n')
  await act(async () => {
    tree = create(createElement(MobileMarkdownPreviewImage, props))
  })
  const image = tree!.root.find((node) => String(node.type) === 'Image')
  expect(image.props.source.uri).toBe('data:image/png;base64,cG5n')
  expect(tree!.root.find((node) => String(node.type) === 'Image').props.style.aspectRatio).toBe(
    600 / 220
  )
  await act(async () =>
    tree!.root.find((node) => String(node.type) === 'Pressable').props.onPress()
  )
  expect(tree!.root.find((node) => String(node.type) === 'ImageViewer').props.uri).toBe(
    'data:image/png;base64,cG5n'
  )
})

it('retries a refused image without hiding the surrounding document', async () => {
  loader
    .mockRejectedValueOnce(new Error('Unable to reach the desktop filesystem'))
    .mockResolvedValueOnce('data:image/png;base64,cG5n')
  await act(async () => {
    tree = create(createElement(MobileMarkdownPreviewImage, props))
  })
  expect(tree!.root.find((node) => String(node.type) === 'LoadError').props.message).toContain(
    'Unable to reach'
  )
  await act(async () =>
    tree!.root.find((node) => String(node.type) === 'LoadError').props.onRetry()
  )
  expect(tree!.root.find((node) => String(node.type) === 'Image').props.source.uri).toBe(
    'data:image/png;base64,cG5n'
  )
})
