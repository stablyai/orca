import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatImageRefBlock } from '../../../../../src/shared/native-chat/native-chat-types'
import { stubRpcClient } from '../../../transport/rpc-client-test-stub'
import type { RpcClient } from '../../../transport/rpc-client'
import {
  findAllByHostType,
  findByHostType
} from '../../../test-support/react-test-renderer-host-nodes'
import { Prose } from '../transcript/MobileNativeChatProse'
import { MobileNativeChatRowOverlaysContext } from '../transcript/mobile-native-chat-row-overlays'

vi.mock('react-native', () => ({
  Image: 'Image',
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View',
  ActivityIndicator: 'ActivityIndicator',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Platform: { OS: 'ios', select: (options: { ios?: unknown }) => options.ios }
}))
vi.mock('../../../components/MobileMarkdown', () => ({ MobileMarkdown: 'MobileMarkdown' }))

const PATH = '/Users/host/Library/Application Support/orca/agent-session-attachments/one/photo.png'
const URI = 'data:image/png;base64,AA=='
const REPLY = {
  id: 'image',
  ok: true as const,
  result: { content: 'AA==', isBinary: true, isImage: true, mimeType: 'image/png' }
}

describe('host-owned mobile chat images', () => {
  let tree: ReactTestRenderer | undefined
  const openImage = vi.fn()
  const render = (
    client: RpcClient | null,
    block: NativeChatImageRefBlock = { type: 'image-ref', path: PATH },
    worktreeId = 'chat',
    onLongPress?: () => void,
    userMessage = false
  ) => {
    const value = {
      openImage,
      openActions: () => {},
      openRewind: () => {},
      imageSource: client ? { client, worktreeId } : undefined
    }
    return createElement(
      MobileNativeChatRowOverlaysContext.Provider,
      { value },
      createElement(Prose, { block, text: '', fontScale: 1, onLongPress, userMessage })
    )
  }
  afterEach(() => {
    act(() => tree?.unmount())
    tree = undefined
    openImage.mockClear()
  })

  function mounted(): ReactTestRenderer {
    if (!tree) {
      throw new Error('image did not mount')
    }
    return tree
  }
  const image = () => findByHostType(mounted().root, 'Image')
  const press = () => findByHostType(mounted().root, 'Pressable')

  it('reads the owning store image and opens its original bytes', async () => {
    const sendRequest = vi.fn<RpcClient['sendRequest']>().mockResolvedValue(REPLY)
    await act(async () => {
      tree = create(render(stubRpcClient({ sendRequest })))
    })
    expect(image().props.source).toEqual({ uri: URI })
    expect(sendRequest).toHaveBeenCalledWith(
      'agentSessionAttachment.read',
      { path: PATH },
      expect.anything()
    )
    act(() => press().props.onPress())
    expect(openImage).toHaveBeenCalledWith({ uri: URI, label: PATH })
  })

  it('opens a device preview directly with its image description', async () => {
    await act(async () => {
      tree = create(
        render(stubRpcClient(), {
          type: 'image-ref',
          path: PATH,
          url: 'file:///phone/photo.png',
          alt: 'Checkout screen'
        })
      )
    })
    act(() => press().props.onPress())
    expect(openImage).toHaveBeenCalledWith({
      uri: 'file:///phone/photo.png',
      label: 'Checkout screen'
    })
  })

  it('recovers an expired device preview and fences old decoder attempts after retry', async () => {
    const client = stubRpcClient({ sendRequest: async () => REPLY })
    await act(async () => {
      tree = create(
        render(client, { type: 'image-ref', path: PATH, url: 'file:///phone/expired.png' })
      )
    })
    const directError = image().props.onError
    await act(async () => directError())
    expect(image().props.source).toEqual({ uri: URI })
    const fallbackError = image().props.onError
    act(() => fallbackError())
    expect(findAllByHostType(mounted().root, 'Image')).toEqual([])
    await act(async () => press().props.onPress())
    expect(image().props.source).toEqual({ uri: URI })
    act(() => {
      directError()
      fallbackError()
    })
    expect(image().props.source).toEqual({ uri: URI })
  })

  it('retries a failed compact image and preserves long-press actions', async () => {
    const sendRequest = vi
      .fn<RpcClient['sendRequest']>()
      .mockRejectedValueOnce(new Error('Disconnected'))
      .mockResolvedValueOnce(REPLY)
    const onLongPress = vi.fn()
    await act(async () => {
      tree = create(render(stubRpcClient({ sendRequest }), undefined, 'chat', onLongPress, true))
    })
    expect(findAllByHostType(mounted().root, 'Image')).toEqual([])
    act(() => press().props.onLongPress())
    expect(onLongPress).toHaveBeenCalled()
    await act(async () => press().props.onPress())
    expect(image().props.source).toEqual({ uri: URI })
    act(() => press().props.onPress())
    expect(openImage).toHaveBeenCalledWith({ uri: URI, label: PATH })
  })

  it('lets a device-only image retry after a decoder failure', async () => {
    await act(async () => {
      tree = create(render(null, { type: 'image-ref', path: URI }))
    })
    expect(press().props.accessibilityLabel).not.toContain('data:image')
    const failedImage = image()
    act(() => failedImage.props.onError())
    expect(findAllByHostType(mounted().root, 'Image')).toEqual([])
    await act(async () => press().props.onPress())
    expect(image().props.source).toEqual({ uri: URI })
    expect(image()).not.toBe(failedImage)
  })

  it('ignores image replies from a replaced owning client', async () => {
    let finish: ((value: typeof REPLY) => void) | undefined
    const oldClient = stubRpcClient({
      sendRequest: () =>
        new Promise((resolve) => {
          finish = resolve
        })
    })
    const nextClient = stubRpcClient({
      sendRequest: async () => ({ ...REPLY, result: { ...REPLY.result, content: 'AQ==' } })
    })
    await act(async () => {
      tree = create(render(oldClient))
    })
    await act(async () => mounted().update(render(nextClient)))
    await act(async () => finish?.(REPLY))
    expect(image().props.source).toEqual({ uri: 'data:image/png;base64,AQ==' })
  })

  it('does not carry a decoder failure into another image path', async () => {
    const client = stubRpcClient({ sendRequest: async () => REPLY })
    await act(async () => {
      tree = create(render(client))
    })
    const oldError = image().props.onError
    act(() => oldError())
    await act(async () =>
      mounted().update(render(client, { type: 'image-ref', path: PATH.replace('one', 'two') }))
    )
    act(() => oldError())
    expect(image().props.source).toEqual({ uri: URI })
  })

  it('routes a non-store host image through its folder workspace', async () => {
    const sendRequest = vi.fn<RpcClient['sendRequest']>().mockResolvedValue(REPLY)
    await act(async () => {
      tree = create(
        render(
          stubRpcClient({ sendRequest }),
          { type: 'image-ref', path: '/private/tmp/checkout.png' },
          'folder:checkout'
        )
      )
    })
    expect(sendRequest).toHaveBeenCalledWith(
      'files.readChatImage',
      { worktree: 'id:folder:checkout', path: '/private/tmp/checkout.png' },
      expect.anything()
    )
    expect(image().props.source).toEqual({ uri: URI })
  })

  it('offers retry after a connection cutover without needing a parent render', async () => {
    let generation = 0
    let finish: ((value: typeof REPLY) => void) | undefined
    const client = stubRpcClient({
      getGeneration: () => generation,
      sendRequest: vi
        .fn<RpcClient['sendRequest']>()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finish = resolve
            })
        )
        .mockResolvedValue(REPLY)
    })
    await act(async () => {
      tree = create(render(client))
    })
    generation++
    await act(async () => finish?.(REPLY))
    expect(findAllByHostType(mounted().root, 'Image')).toEqual([])
    expect(findAllByHostType(mounted().root, 'ActivityIndicator')).toEqual([])
    await act(async () => press().props.onPress())
    expect(image().props.source).toEqual({ uri: URI })
  })

  it('recovers a decoder failure after reconnect without waiting for a parent render', async () => {
    let generation = 0
    const client = stubRpcClient({
      getGeneration: () => generation,
      sendRequest: async () => REPLY
    })
    await act(async () => {
      tree = create(
        render(client, { type: 'image-ref', path: PATH, url: 'file:///phone/expired.png' })
      )
    })
    generation++
    await act(async () => image().props.onError())
    expect(image().props.source).toEqual({ uri: URI })
  })
})
