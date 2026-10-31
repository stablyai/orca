import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatImageRefBlock } from '../../../../../src/shared/native-chat-types'
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
    onLongPress?: () => void
  ) => {
    const value = {
      openImage,
      openActions: () => {},
      imageSource: client ? { client, worktreeId } : undefined
    }
    return createElement(
      MobileNativeChatRowOverlaysContext.Provider,
      { value },
      createElement(Prose, { block, text: '', fontScale: 1, onLongPress })
    )
  }
  afterEach(() => {
    act(() => tree?.unmount())
    tree = undefined
    openImage.mockClear()
  })

  it('loads a stored host image and opens the fetched bytes full size', async () => {
    const sendRequest = vi.fn<RpcClient['sendRequest']>().mockResolvedValue(REPLY)
    await act(async () => {
      tree = create(render(stubRpcClient({ sendRequest })))
    })
    if (!tree) {
      throw new Error('image did not mount')
    }
    expect(findAllByHostType(tree.root, 'Image').map((node) => node.props.source)).toEqual([
      { uri: URI }
    ])
    expect(sendRequest).toHaveBeenCalledWith(
      'agentSessionAttachment.read',
      { path: PATH },
      expect.anything()
    )
    const button = tree.root.findAllByProps({ accessibilityLabel: 'Attached image' })[0]
    act(() => button?.props.onPress())
    expect(openImage).toHaveBeenCalledWith({ uri: URI, label: 'Attached image' })
  })

  it('keeps the device preview without reading its host path', async () => {
    const sendRequest = vi.fn<RpcClient['sendRequest']>()
    await act(async () => {
      tree = create(
        render(stubRpcClient({ sendRequest }), {
          type: 'image-ref',
          path: PATH,
          url: 'file:///phone/photo.png'
        })
      )
    })
    if (!tree) {
      throw new Error('image did not mount')
    }
    expect(findByHostType(tree.root, 'Image').props.source).toEqual({
      uri: 'file:///phone/photo.png'
    })
    expect(sendRequest).not.toHaveBeenCalled()
    act(() => tree?.root.findByProps({ accessibilityLabel: 'Attached image' }).props.onPress())
    expect(openImage).toHaveBeenCalledWith({
      uri: 'file:///phone/photo.png',
      label: 'Attached image'
    })
  })

  it('falls back to the selected host when a direct preview cannot decode', async () => {
    const sendRequest = vi.fn<RpcClient['sendRequest']>().mockResolvedValue(REPLY)
    await act(async () => {
      tree = create(
        render(stubRpcClient({ sendRequest }), {
          type: 'image-ref',
          path: PATH,
          url: 'file:///phone/expired.png'
        })
      )
    })
    if (!tree) {
      throw new Error('image did not mount')
    }
    expect(findByHostType(tree.root, 'Image').props.source.uri).toBe('file:///phone/expired.png')
    expect(sendRequest).not.toHaveBeenCalled()
    await act(async () => findByHostType(tree!.root, 'Image').props.onError())
    expect(findByHostType(tree.root, 'Image').props.source).toEqual({ uri: URI })
    expect(sendRequest).toHaveBeenCalledExactlyOnceWith(
      'agentSessionAttachment.read',
      { path: PATH },
      expect.anything()
    )
    act(() => tree?.root.findByProps({ accessibilityLabel: 'Attached image' }).props.onPress())
    expect(openImage).toHaveBeenCalledWith({ uri: URI, label: 'Attached image' })
  })

  it('retries a failed fallback read without choosing the broken direct preview again', async () => {
    const sendRequest = vi
      .fn<RpcClient['sendRequest']>()
      .mockRejectedValueOnce(new Error('Disconnected'))
      .mockResolvedValueOnce(REPLY)
    await act(async () => {
      tree = create(
        render(stubRpcClient({ sendRequest }), {
          type: 'image-ref',
          path: PATH,
          url: 'file:///phone/expired.png'
        })
      )
    })
    if (!tree) {
      throw new Error('image did not mount')
    }
    await act(async () => findByHostType(tree!.root, 'Image').props.onError())
    expect(findAllByHostType(tree.root, 'Image')).toHaveLength(0)
    await act(async () =>
      tree?.root.findByProps({ accessibilityLabel: 'Image unavailable' }).props.onPress()
    )
    expect(findByHostType(tree.root, 'Image').props.source).toEqual({ uri: URI })
    expect(sendRequest).toHaveBeenCalledTimes(2)
  })

  it('retries fallback decoder failures and ignores the previous decoder attempt', async () => {
    const sendRequest = vi.fn<RpcClient['sendRequest']>().mockResolvedValue(REPLY)
    await act(async () => {
      tree = create(
        render(stubRpcClient({ sendRequest }), {
          type: 'image-ref',
          path: PATH,
          url: 'file:///phone/expired.png'
        })
      )
    })
    if (!tree) {
      throw new Error('image did not mount')
    }
    const directError = findByHostType(tree.root, 'Image').props.onError
    await act(async () => directError())
    const failedImage = findByHostType(tree.root, 'Image')
    const fallbackError = failedImage.props.onError
    act(() => fallbackError())
    expect(findAllByHostType(tree.root, 'Image')).toHaveLength(0)
    act(() => directError())
    expect(tree.root.findByProps({ accessibilityLabel: 'Image unavailable' })).toBeDefined()
    await act(async () =>
      tree?.root.findByProps({ accessibilityLabel: 'Image unavailable' }).props.onPress()
    )
    expect(findByHostType(tree.root, 'Image').props.source).toEqual({ uri: URI })
    expect(findByHostType(tree.root, 'Image')).not.toBe(failedImage)
    act(() => fallbackError())
    expect(findByHostType(tree.root, 'Image').props.source).toEqual({ uri: URI })
    expect(sendRequest).toHaveBeenCalledTimes(2)
  })

  it.each([
    { path: 'file:///phone/photo.png' },
    { url: 'content://phone/photo' },
    { url: 'blob:phone/photo' }
  ])('retries a device URI without reading non-store paths %j', async (source) => {
    const sendRequest = vi.fn<RpcClient['sendRequest']>()
    await act(async () => {
      tree = create(render(stubRpcClient({ sendRequest }), { type: 'image-ref', ...source }))
    })
    if (!tree) {
      throw new Error('image did not mount')
    }
    const image = findByHostType(tree.root, 'Image')
    const uri = image.props.source.uri
    act(() => image.props.onError())
    expect(findAllByHostType(tree.root, 'Image')).toHaveLength(0)
    await act(async () =>
      tree?.root.findByProps({ accessibilityLabel: 'Image unavailable' }).props.onPress()
    )
    expect(findByHostType(tree.root, 'Image').props.source).toEqual({ uri })
    expect(findByHostType(tree.root, 'Image')).not.toBe(image)
    expect(sendRequest).not.toHaveBeenCalled()
  })

  it.each(['client', 'workspace', 'generation', 'path', 'url'])(
    'ignores old fallback replies and decoder events after the %s changes',
    async (change) => {
      let generation = 0
      let finish: ((reply: typeof REPLY) => void) | undefined
      const sendRequest = vi
        .fn<RpcClient['sendRequest']>()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finish = resolve
            })
        )
        .mockResolvedValue(REPLY)
      const client = stubRpcClient({ sendRequest, getGeneration: () => generation })
      const block: NativeChatImageRefBlock = {
        type: 'image-ref',
        path: PATH,
        url: 'file:///phone/expired.png'
      }
      await act(async () => {
        tree = create(render(client, block))
      })
      if (!tree) {
        throw new Error('image did not mount')
      }
      const oldError = findByHostType(tree.root, 'Image').props.onError
      await act(async () => oldError())
      expect(tree.root.findByProps({ accessibilityLabel: 'Loading image' })).toBeDefined()
      const nextClient = change === 'client' ? stubRpcClient({ sendRequest }) : client
      const nextBlock = {
        ...block,
        path: change === 'path' ? PATH.replace('one', 'two') : PATH,
        url: change === 'url' ? 'file:///phone/next.png' : block.url
      }
      if (change === 'generation') {
        generation++
      }
      await act(async () =>
        tree?.update(render(nextClient, nextBlock, change === 'workspace' ? 'next' : 'chat'))
      )
      expect(findByHostType(tree.root, 'Image').props.source).toEqual({ uri: nextBlock.url })
      await act(async () => findByHostType(tree!.root, 'Image').props.onError())
      expect(findByHostType(tree.root, 'Image').props.source).toEqual({ uri: URI })
      act(() => findByHostType(tree!.root, 'Image').props.onError())
      await act(async () => {
        oldError()
        finish?.(REPLY)
      })
      expect(findAllByHostType(tree.root, 'Image')).toHaveLength(0)
      expect(tree.root.findByProps({ accessibilityLabel: 'Image unavailable' })).toBeDefined()
      expect(sendRequest).toHaveBeenCalledTimes(2)
    }
  )

  it.each(['/var/folders/host/T/orca-paste-123.png', '/private/tmp/fixtures/screen.png'])(
    'reads a transcript image outside the attachment store with its owning workspace: %s',
    async (path) => {
      const sendRequest = vi.fn<RpcClient['sendRequest']>().mockResolvedValue(REPLY)
      await act(async () => {
        tree = create(render(stubRpcClient({ sendRequest }), { type: 'image-ref', path }))
      })
      expect(sendRequest).toHaveBeenCalledExactlyOnceWith(
        'files.readChatImage',
        { worktree: 'id:chat', path },
        expect.anything()
      )
      expect(tree && findByHostType(tree.root, 'Image').props.source).toEqual({ uri: URI })
    }
  )

  it('does not read a host image when its owning client is absent', async () => {
    await act(async () => {
      tree = create(render(null, { type: 'image-ref', path: '/private/tmp/screen.png' }))
    })
    expect(tree && findAllByHostType(tree.root, 'Image')).toEqual([])
  })

  it('ignores a decoder event from an old generation before the next render', async () => {
    let generation = 0
    const sendRequest = vi.fn<RpcClient['sendRequest']>().mockResolvedValue(REPLY)
    const client = stubRpcClient({ sendRequest, getGeneration: () => generation })
    const block: NativeChatImageRefBlock = {
      type: 'image-ref',
      path: PATH,
      url: 'file:///phone/photo.png'
    }
    await act(async () => {
      tree = create(render(client, block))
    })
    if (!tree) {
      throw new Error('image did not mount')
    }
    generation++
    await act(async () => findByHostType(tree!.root, 'Image').props.onError())
    expect(sendRequest).not.toHaveBeenCalled()
    await act(async () => tree?.update(render(client, block)))
    expect(findByHostType(tree.root, 'Image').props.source).toEqual({ uri: block.url })
    await act(async () => findByHostType(tree!.root, 'Image').props.onError())
    expect(findByHostType(tree.root, 'Image').props.source).toEqual({ uri: URI })
    expect(sendRequest).toHaveBeenCalledTimes(1)
  })

  it('lets a failed read retry without showing a broken image', async () => {
    const onLongPress = vi.fn()
    const sendRequest = vi
      .fn<RpcClient['sendRequest']>()
      .mockResolvedValueOnce({
        id: 'image',
        ok: false,
        error: { code: 'forbidden', message: 'Unavailable' }
      })
      .mockResolvedValueOnce(REPLY)
    const client = stubRpcClient({ sendRequest })
    await act(async () => {
      tree = create(render(client, undefined, 'chat', onLongPress))
    })
    if (!tree) {
      throw new Error('image did not mount')
    }
    expect(findAllByHostType(tree.root, 'Image')).toEqual([])
    const retry = tree.root.findAllByProps({ accessibilityLabel: 'Image unavailable' })[0]
    expect(retry).toBeDefined()
    await act(async () => retry?.props.onLongPress?.())
    expect(onLongPress).toHaveBeenCalledOnce()
    expect(sendRequest).toHaveBeenCalledTimes(1)
    await act(async () => retry?.props.onPress())
    expect(findAllByHostType(tree.root, 'Image').map((node) => node.props.source)).toEqual([
      { uri: URI }
    ])
  })

  it('ignores bytes returned after the selected owning host changes', async () => {
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
    await act(async () => tree?.update(render(nextClient)))
    await act(async () => finish?.(REPLY))
    if (!tree) {
      throw new Error('image did not mount')
    }
    expect(findAllByHostType(tree.root, 'Image').map((node) => node.props.source)).toEqual([
      { uri: 'data:image/png;base64,AQ==' }
    ])
  })

  it('does not carry a decoder failure into another owning host', async () => {
    const client = stubRpcClient({ sendRequest: async () => REPLY })
    const nextClient = stubRpcClient({ sendRequest: async () => REPLY })
    await act(async () => {
      tree = create(render(client))
    })
    if (!tree) {
      throw new Error('image did not mount')
    }
    act(() => findByHostType(tree!.root, 'Image').props.onError())
    expect(findAllByHostType(tree.root, 'Image')).toEqual([])
    await act(async () => tree?.update(render(nextClient)))
    expect(findAllByHostType(tree.root, 'Image').map((node) => node.props.source)).toEqual([
      { uri: URI }
    ])
  })

  it('discards an old logical-client generation even before its next render', async () => {
    let generation = 0
    let finish: ((value: typeof REPLY) => void) | undefined
    let calls = 0
    const client = stubRpcClient({
      getGeneration: () => generation,
      sendRequest: () =>
        ++calls === 1
          ? new Promise((resolve) => {
              finish = resolve
            })
          : Promise.resolve(REPLY)
    })
    await act(async () => {
      tree = create(render(client))
    })
    generation = 1
    await act(async () => finish?.(REPLY))
    if (!tree) {
      throw new Error('image did not mount')
    }
    expect(findAllByHostType(tree.root, 'Image')).toEqual([])
    await act(async () => tree?.update(render(client)))
    expect(findAllByHostType(tree.root, 'Image').map((node) => node.props.source)).toEqual([
      { uri: URI }
    ])
  })

  it.each([
    {},
    { content: 'AA==', isImage: false, mimeType: 'image/png' },
    { content: 'AA==', isImage: true, mimeType: 'text/html' },
    { content: 5, isImage: true, mimeType: 'image/png' }
  ])('shows an unavailable state for unusable host image data %j', async (result) => {
    const client = stubRpcClient({ sendRequest: async () => ({ id: 'image', ok: true, result }) })
    await act(async () => {
      tree = create(render(client))
    })
    if (!tree) {
      throw new Error('image did not mount')
    }
    expect(findAllByHostType(tree.root, 'Image')).toEqual([])
    expect(tree.root.findAllByProps({ accessibilityLabel: 'Image unavailable' })).toHaveLength(1)
  })
})
