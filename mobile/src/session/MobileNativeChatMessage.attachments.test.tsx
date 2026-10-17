import { MobileNativeChatRowOverlaysContext } from './mobile-native-chat-row-overlays'
import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { MobileNativeChatRowOverlaysHost } from './MobileNativeChatRowOverlaysHost'
import { MobileNativeChatMessage } from './MobileNativeChatMessage'
import { MobileNativeChatAttachmentContext } from './mobile-native-chat-attachment-read'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import type { RpcResponse } from '../transport/types'
import { styles } from './mobile-native-chat-message-styles'

vi.mock('react-native-gesture-handler', () => ({
  GestureHandlerRootView: 'View',
  GestureDetector: ({ children }: { children: unknown }) => children,
  Gesture: { Native: () => ({}) }
}))
vi.mock('./MobileNativeChatZoomableImagePage', () => ({
  MobileNativeChatZoomableImagePage: 'AndroidImagePage'
}))
vi.mock('react-native', async () => {
  const React = await import('react')
  const Text = ({ children, ...props }: { children?: ReactNode }): unknown =>
    React.createElement('Text', props, children)
  return {
    ActivityIndicator: 'ActivityIndicator',
    Animated: {
      Text,
      Value: class {
        setValue(): void {}
      },
      loop: (animation: unknown) => animation,
      sequence: () => ({ start: vi.fn(), stop: vi.fn() }),
      timing: () => ({ start: vi.fn(), stop: vi.fn() })
    },
    Image: 'Image',
    Modal: 'Modal',
    FlatList: 'FlatList',
    useWindowDimensions: () => ({ width: 390, height: 844 }),
    Platform: { OS: 'ios' },
    Pressable: 'Pressable',
    ScrollView: ({ children, ...props }: { children?: ReactNode }) =>
      React.createElement('ScrollView', props, children),
    Text,
    View: ({ children, ...props }: { children?: ReactNode }) =>
      React.createElement('View', props, children),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 }
  }
})
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }))
vi.mock('lucide-react-native', () => ({
  FileText: 'FileText',
  X: 'X',
  AlertCircle: 'AlertCircle',
  MessageSquareMore: 'MessageSquareMore',
  AlertTriangle: 'AlertTriangle',
  ArrowUp: 'ArrowUp',
  Brain: 'Brain',
  ChevronDown: 'ChevronDown',
  Copy: 'Copy',
  SquareChevronRight: 'SquareChevronRight',
  SquareTerminal: 'SquareTerminal',
  Wrench: 'Wrench',
  ChevronRight: 'ChevronRight'
}))
vi.mock('../components/MobileMarkdown', () => ({ MobileMarkdown: 'MobileMarkdown' }))
vi.mock('./MobileNativeChatMessageActionsSheet', () => ({
  MobileNativeChatMessageActionsSheet: 'MessageActionsSheet'
}))
vi.mock('../layout/side-safe-area', () => ({
  useWindowSafeAreaInsets: () => ({ top: 24, bottom: 24, left: 0, right: 0 })
}))

const path = '/root/.orca/agent-session-attachments/session/image.png'
const message: NativeChatMessage = {
  id: 'image',
  role: 'user',
  source: 'hook',
  timestamp: 0,
  blocks: [{ type: 'image-ref', path, alt: 'Uploaded screenshot' }]
}
let renderer: ReactTestRenderer | undefined
afterEach(() => act(() => renderer?.unmount()))

it('loads a historical attachment from the chat execution host and displays its image', async () => {
  const sendRequest = vi.fn(async () => ({
    id: '1',
    ok: true as const,
    result: { isImage: true, isBinary: true, mimeType: 'image/png', content: 'AAAA' }
  }))
  await act(async () => {
    renderer = create(
      createElement(
        MobileNativeChatAttachmentContext.Provider,
        { value: { sendRequest } },
        createElement(MobileNativeChatMessage, { message })
      )
    )
  })
  expect(sendRequest).toHaveBeenCalledWith(
    'agentSessionAttachment.read',
    { path },
    expect.objectContaining({ timeoutMs: 15_000 })
  )
  expect(renderer!.root.find((node) => String(node.type) === 'Image').props.source).toEqual({
    uri: 'data:image/png;base64,AAAA'
  })
})

it('offers a retry when the owning host cannot serve an attachment', async () => {
  const sendRequest = vi.fn(async () => ({
    id: '1',
    ok: false as const,
    error: { code: 'method_not_found', message: 'Not supported' }
  }))
  await act(async () => {
    renderer = create(
      createElement(
        MobileNativeChatAttachmentContext.Provider,
        { value: { sendRequest } },
        createElement(MobileNativeChatMessage, { message })
      )
    )
  })
  const retry = renderer!.root.find(
    (node) => String(node.type) === 'Pressable' && node.props.accessibilityLabel === 'Retry image'
  )
  await act(async () => retry.props.onPress())
  expect(sendRequest).toHaveBeenCalledTimes(2)
})

it('never displays a previous host image when the same path is opened on another host', async () => {
  let finish: (reply: RpcResponse) => void = () => {}
  const pending = new Promise<RpcResponse>((resolve) => {
    finish = resolve
  })
  const first = {
    sendRequest: vi.fn(async () => ({
      id: '1',
      ok: true as const,
      result: { isImage: true, mimeType: 'image/png', content: 'AAAA' }
    }))
  }
  const second = { sendRequest: vi.fn(() => pending) }
  const element = (client: typeof first | typeof second) =>
    createElement(
      MobileNativeChatAttachmentContext.Provider,
      { value: client },
      createElement(MobileNativeChatMessage, { message })
    )
  await act(async () => {
    renderer = create(element(first))
  })
  expect(renderer!.root.findAll((node) => String(node.type) === 'Image')).toHaveLength(1)
  await act(async () => renderer!.update(element(second)))
  expect(renderer!.root.findAll((node) => String(node.type) === 'Image')).toHaveLength(0)
  await act(async () =>
    finish({ id: '2', ok: true, result: { isImage: true, mimeType: 'image/png', content: 'BBBB' } })
  )
  expect(renderer!.root.find((node) => String(node.type) === 'Image').props.source).toEqual({
    uri: 'data:image/png;base64,BBBB'
  })
})

it('does not ask the attachment reader for arbitrary host filesystem paths', async () => {
  const sendRequest = vi.fn()
  await act(async () => {
    renderer = create(
      createElement(
        MobileNativeChatAttachmentContext.Provider,
        { value: { sendRequest } },
        createElement(MobileNativeChatMessage, {
          message: { ...message, blocks: [{ type: 'image-ref', path: '/etc/private.png' }] }
        })
      )
    )
  })
  expect(sendRequest).not.toHaveBeenCalled()
})

it('keeps an image-only message outside any text bubble', async () => {
  await act(async () => {
    renderer = create(
      createElement(MobileNativeChatMessage, {
        message: {
          ...message,
          blocks: [{ type: 'image-ref', url: 'file:///a.png' }]
        }
      })
    )
  })
  expect(
    renderer!.root.findAll(
      (node) => Array.isArray(node.props.style) && node.props.style.includes(styles.userBubble)
    )
  ).toHaveLength(0)
})

it('places text in its own bubble below the image', async () => {
  await act(async () => {
    renderer = create(
      createElement(MobileNativeChatMessage, {
        message: {
          ...message,
          blocks: [
            { type: 'text', text: 'What is this?' },
            { type: 'image-ref', url: 'file:///a.png' }
          ]
        }
      })
    )
  })
  const bubbles = renderer!.root.findAll(
    (node) =>
      String(node.type) === 'View' &&
      Array.isArray(node.props.style) &&
      node.props.style.includes(styles.userBubble)
  )
  expect(bubbles).toHaveLength(1)
  expect(bubbles[0]!.findAll((node) => String(node.type) === 'Image')).toHaveLength(0)
})

it('uses the same compact square crop and bubble radius for one photo as for multiple photos', async () => {
  await act(async () => {
    renderer = create(
      createElement(MobileNativeChatMessage, {
        message: { ...message, blocks: [{ type: 'image-ref', url: 'file:///one.png' }] }
      })
    )
  })
  const thumbnail = renderer!.root.find(
    (node) =>
      String(node.type) === 'Pressable' && node.props.accessibilityLabel === 'Open image 1 of 1'
  )
  expect(thumbnail.props.style).toMatchObject({
    width: 88,
    aspectRatio: 1,
    borderRadius: styles.userBubble.borderRadius
  })
  expect(renderer!.root.find((node) => String(node.type) === 'Image').props.resizeMode).toBe(
    'cover'
  )
})

it('shows stored files above the text, expands additional files, and opens the original host path', async () => {
  const onOpenFile = vi.fn()
  const paths = Array.from(
    { length: 5 },
    (_, index) => `/root/.orca/agent-session-attachments/id/file${index}.pdf`
  )
  await act(async () => {
    renderer = create(
      createElement(MobileNativeChatMessage, {
        message: {
          ...message,
          blocks: [
            { type: 'text', text: `${paths.map((path) => `@${path}`).join(' ')}\nPlease review.` }
          ]
        },
        onOpenFile
      })
    )
  })
  const fileTiles = () =>
    renderer!.root.findAll(
      (node) =>
        String(node.type) === 'Pressable' && node.props.accessibilityLabel?.startsWith('Open file ')
    )
  expect(fileTiles()).toHaveLength(3)
  const more = renderer!.root.find(
    (node) =>
      String(node.type) === 'Pressable' && node.props.accessibilityLabel === 'View all 5 files'
  )
  await act(async () => more.props.onPress())
  expect(fileTiles()).toHaveLength(5)
  await act(async () => fileTiles()[4]!.props.onPress())
  expect(onOpenFile).toHaveBeenCalledWith(paths[4])
  const bubble = renderer!.root.find(
    (node) =>
      String(node.type) === 'View' &&
      Array.isArray(node.props.style) &&
      node.props.style.includes(styles.userBubble)
  )
  expect(bubble.findAll((node) => String(node.type) === 'FileText')).toHaveLength(0)
  expect(
    bubble.findAll((node) => node.props.content === '\nPlease review.').length
  ).toBeGreaterThan(0)
})

it.each(['user', 'assistant'] as const)(
  'shows three %s thumbnails with overflow on the third and opens the tapped image in the full gallery',
  async (role) => {
    await act(async () => {
      renderer = create(
        <MobileNativeChatRowOverlaysHost
          conversation={{ surfaceId: 'gallery-tab', sessionId: 'gallery-session' }}
        >
          <MobileNativeChatMessage
            message={{
              ...message,
              role,
              blocks: Array.from({ length: 5 }, (_, index) => ({
                type: 'image-ref' as const,
                url: `file:///${index}.png`
              }))
            }}
          />
        </MobileNativeChatRowOverlaysHost>
      )
    })
    expect(renderer!.root.findAll((node) => String(node.type) === 'Image')).toHaveLength(3)
    const more = renderer!.root.find(
      (node) =>
        String(node.type) === 'Pressable' && node.props.accessibilityLabel === 'Open image 3 of 5'
    )
    expect(renderer!.root.findAll((node) => String(node.type) === 'Pressable')).toHaveLength(3)
    expect(
      more.findAll((node) => String(node.type) === 'Text' && node.props.children?.[0] === '+')
    ).toHaveLength(1)
    await act(async () => more.props.onPress())
    const gallery = renderer!.root.find((node) => String(node.type) === 'FlatList')
    expect(gallery.props.data).toHaveLength(5)
    expect(gallery.props.initialScrollIndex).toBe(2)
  }
)

it('does not carry a decode failure or late error into the same path on a different host client', async () => {
  const makeClient = () => ({
    sendRequest: vi.fn(async () => ({
      id: 'r',
      ok: true as const,
      result: { isImage: true, isBinary: true, mimeType: 'image/png', content: 'AA==' }
    }))
  })
  const first = makeClient()
  const second = makeClient()
  const content = (client: typeof first) =>
    createElement(
      MobileNativeChatAttachmentContext.Provider,
      { value: client },
      createElement(MobileNativeChatMessage, { message })
    )
  await act(async () => {
    renderer = create(content(first))
  })
  const oldError = renderer!.root.find((node) => String(node.type) === 'Image').props.onError
  act(() => oldError())
  expect(renderer!.root.findAll((node) => String(node.type) === 'Image')).toHaveLength(0)
  await act(async () => {
    renderer!.update(content(second))
  })
  expect(second.sendRequest).toHaveBeenCalledOnce()
  expect(renderer!.root.findAll((node) => String(node.type) === 'Image')).toHaveLength(1)
  act(() => oldError())
  expect(renderer!.root.findAll((node) => String(node.type) === 'Image')).toHaveLength(1)
})

it('opens an attachment full size when tapped', () => {
  const openImage = vi.fn()
  act(() => {
    renderer = create(
      createElement(
        MobileNativeChatRowOverlaysContext.Provider,
        { value: { openImage, openActions: vi.fn() } },
        createElement(MobileNativeChatMessage, {
          message: {
            ...message,
            blocks: [{ type: 'image-ref', url: 'file:///a.jpg', alt: 'a photo' }]
          }
        })
      )
    )
  })
  act(() => renderer!.root.findByProps({ accessibilityLabel: 'Open image 1 of 1' }).props.onPress())
  expect(openImage).toHaveBeenCalledWith(
    expect.objectContaining({
      uri: 'file:///a.jpg',
      label: 'a photo',
      gallery: {
        images: [{ type: 'image-ref', url: 'file:///a.jpg', alt: 'a photo' }],
        initialIndex: 0
      }
    })
  )
})
