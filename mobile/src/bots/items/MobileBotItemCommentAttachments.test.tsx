import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'

vi.mock('react-native', async () => {
  const React = await import('react')
  const { reactNativeMotionStub } = await import('../../test-support/react-native-motion-stub')
  const host =
    (name: string) =>
    ({ children, ...props }: { children?: ReactNode }) =>
      React.createElement(name, props, children)
  return {
    ...reactNativeMotionStub(),
    Platform: { OS: 'ios', select: (options: { ios?: unknown }) => options.ios },
    Appearance: { getColorScheme: () => 'dark', addChangeListener: () => ({ remove() {} }) },
    useColorScheme: () => 'dark',
    Image: host('Image'),
    Pressable: host('Pressable'),
    Text: host('Text'),
    View: host('View'),
    StyleSheet: {
      create: (styles: unknown) => styles,
      hairlineWidth: 1,
      flatten: (s: unknown) => s
    }
  }
})
vi.mock('../../session/native-chat/visual/mobile-native-chat-image-preview', () => ({
  readHostChatImage: async (_source: unknown, path: string) => `data:image/png;base64,${path}`
}))
vi.mock('../../files/media/presentation/MobileImageViewer', () => ({
  MobileImageViewer: (props: { label: string; onNext?: (() => void) | null }) =>
    createElement('Viewer', props)
}))

import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { MobileBotItemCommentAttachments } from './MobileBotItemCommentAttachments'

const STORE = '/Users/x/.orca/agent-session-attachments/0b6f8a52-4a3e-4c4e-9a59-1d5d1f2b8c01'

it('folds images past six to five and "+N", steps the viewer through them, and opens files by path', async () => {
  const images = Array.from({ length: 8 }, (_, n) => ({
    path: `${STORE}/shot-${n + 1}.png`,
    name: `shot-${n + 1}.png`,
    bytes: 3
  }))
  const onOpenFile = vi.fn()
  let tree!: ReactTestRenderer
  await act(async () => {
    tree = create(
      createElement(MobileBotItemCommentAttachments, {
        data: { text: `Full run.\n\n@${STORE}/run.log`, images },
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: image reads are mocked and never touch the client.
        client: {} as RpcClient,
        onOpenFile
      })
    )
  })
  const grid = tree.root.find((node) => typeof node.props.onLayout === 'function')
  await act(async () => grid.props.onLayout({ nativeEvent: { layout: { width: 300 } } }))

  const tiles = tree.root.findAll(
    (node) => String(node.type) === 'Pressable' && node.props.accessibilityRole === 'imagebutton'
  )
  expect(tiles.map((tile) => tile.props.accessibilityLabel)).toEqual([
    'shot-1.png',
    'shot-2.png',
    'shot-3.png',
    'shot-4.png',
    'shot-5.png'
  ])
  expect(
    tree.root.findAll((node) => String(node.type) === 'Text' && node.props.children === '+3')
  ).toHaveLength(1)

  await act(async () => tiles[4]!.props.onPress())
  const viewer = () => tree.root.find((node) => String(node.type) === 'Viewer')
  expect(viewer().props.label).toBe('shot-5.png')
  await act(async () => viewer().props.onNext())
  expect(viewer().props.label).toBe('shot-6.png')

  await act(async () =>
    tree.root
      .find((node) => String(node.type) === 'Text' && node.props.accessibilityLabel === 'run.log')
      .props.onPress()
  )
  expect(onOpenFile).toHaveBeenCalledWith(`${STORE}/run.log`)
})
