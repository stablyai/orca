import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { MobileNativeChatImage } from './MobileNativeChatImage'
import {
  MobileNativeChatResourceContext,
  type MobileNativeChatResourceSource
} from './mobile-native-chat-resource-read'
import type { RpcResponse } from '../transport/types'

vi.mock('react-native', () => ({
  Image: 'Image',
  Text: 'Text',
  View: 'View',
  Pressable: 'Pressable',
  ActivityIndicator: 'Spinner',
  Platform: { OS: 'web' },
  StyleSheet: { create: (s: unknown) => s }
}))
let renderer: ReactTestRenderer | undefined
afterEach(() => act(() => renderer?.unmount()))
const path = '/mnt/data/chart.png'
function view(source: MobileNativeChatResourceSource) {
  return (
    <MobileNativeChatResourceContext.Provider value={source}>
      <MobileNativeChatImage uri={path} alt="Chart" fontScale={1} />
    </MobileNativeChatResourceContext.Provider>
  )
}
function owner(
  sendRequest: MobileNativeChatResourceSource['client']['sendRequest'],
  hostId: string
): MobileNativeChatResourceSource {
  return {
    client: { sendRequest },
    hostId,
    worktreeId: 'wt-1',
    nativeChatContext: { tabId: 'chat', sessionId: 'session' }
  }
}
function resolved(): RpcResponse {
  return {
    id: 'reply',
    ok: true,
    result: {
      exists: true,
      isDirectory: false,
      openTarget: { kind: 'absolute-file', absolutePath: path, grantId: 'grant' }
    }
  }
}
function image(bytes: string): RpcResponse {
  return {
    id: 'reply',
    ok: true,
    result: { isImage: true, isBinary: true, mimeType: 'image/png', content: bytes }
  }
}
it('discards late image bytes when the conversation moves to another host', async () => {
  let finish: (result: RpcResponse) => void = () => {
    throw new Error('Read not started')
  }
  const oldSend = vi.fn(async (method: string) =>
    method === 'files.resolveTerminalPath'
      ? resolved()
      : new Promise<RpcResponse>((resolve) => {
          finish = resolve
        })
  )
  await act(async () => {
    renderer = create(view(owner(oldSend, 'old-host')))
  })
  const newSend = vi.fn(async (method: string) =>
    method === 'files.resolveTerminalPath' ? resolved() : image('BBBB')
  )
  await act(async () => {
    renderer!.update(view(owner(newSend, 'new-host')))
  })
  await act(async () => finish(image('AAAA')))
  expect(renderer!.root.find((node) => String(node.type) === 'Image').props.source.uri).toBe(
    'data:image/png;base64,BBBB'
  )
})
it('offers a retry after refusal without trying the attachment or client filesystem route', async () => {
  const send = vi.fn(async (_method: string): Promise<RpcResponse> => ({
    id: 'reply',
    ok: false,
    error: { code: 'forbidden', message: 'Host refused' }
  }))
  await act(async () => {
    renderer = create(view(owner(send, 'host')))
  })
  const retry = renderer!.root.find((node) => node.props.accessibilityLabel === 'Retry image')
  expect(send).toHaveBeenCalledTimes(1)
  await act(async () => retry.props.onPress())
  expect(send).toHaveBeenCalledTimes(2)
  expect(send.mock.calls.every(([method]) => method === 'files.resolveTerminalPath')).toBe(true)
})
