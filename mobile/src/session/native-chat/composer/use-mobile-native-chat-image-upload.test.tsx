import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RpcClientProvider } from '../../../transport/client-context.web'
import {
  createFakeBridgePortPair,
  type BridgePortPair
} from '../../../mobile-web-shell/bridge/bridge-port-pair-test-harness'
import { useMobileNativeChatImageUpload } from './use-mobile-native-chat-image-upload'

vi.mock('../../../platform/media-picker', async () => import('../../../platform/media-picker.web'))
vi.mock('../../../transport/host-client-hooks', () => ({
  useDisconnectHostClient: () => () => {},
  useForceReconnect: () => null,
  useForgetHostClient: () => () => {},
  useHostClient: () => ({ client: null, clientId: null, state: 'disconnected' }),
  usePrimeHosts: () => () => {},
  useRefreshHostClient: () => () => {}
}))

type Upload = ReturnType<typeof useMobileNativeChatImageUpload>
let tree: ReactTestRenderer | null = null
let pair: BridgePortPair | null = null

afterEach(() => {
  act(() => tree?.unmount())
  tree = null
  pair?.client.close()
  pair?.host.dispose()
  pair = null
  vi.restoreAllMocks()
})

async function attach(options: Parameters<typeof createFakeBridgePortPair>[0]) {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const bridge = createFakeBridgePortPair(options)
  pair = bridge
  await bridge.flush()
  const showToast = vi.fn()
  const onError = vi.fn()
  const onImagesUploaded = vi.fn()
  const held: { upload: Upload | null } = { upload: null }
  function Screen(): null {
    held.upload = useMobileNativeChatImageUpload({
      client: bridge.client,
      activeHandleRef: { current: null },
      getActiveWorktreeConnectionId: async () => null,
      connState: 'connected',
      scopeKey: 'folder-chat',
      structuredNativeChat: true,
      showToast,
      onError,
      onImagesUploaded
    })
    return null
  }
  act(() => {
    tree = create(
      <RpcClientProvider client={bridge.client}>
        <Screen />
      </RpcClientProvider>
    )
  })
  const upload = held.upload
  if (upload === null) {
    throw new Error('upload hook did not mount')
  }
  await act(async () => {
    const work = upload.attachImage('library')
    await bridge.flush()
    await work
  })
  expect(bridge.rpc.requests).toEqual([])
  expect(onImagesUploaded).not.toHaveBeenCalled()
  expect(held.upload?.isAttaching).toBe(false)
  return { bridge, showToast, onError }
}

describe('Attach Photos native refusal handling', () => {
  it.each([
    ['native_media_permission_denied', 'Photo permission denied'],
    ['native_verb_ungranted', 'Media attachments unavailable here'],
    ['native_verb_unknown', 'Media attachments unavailable here'],
    ['native_media_handle_cap', 'Attachment capacity reached'],
    ['native_media_too_large', 'Image too large to attach'],
    ['native_verb_failed', 'Attach failed'],
    ['private-newer-code', 'Attach failed']
  ])('handles %s without inventing a cause or exposing native text', async (code, message) => {
    const result = await attach({
      serveNativeVerb: async () => {
        throw Object.assign(new Error('private /photos/name.jpg data:image/png;base64,AAAA'), {
          code
        })
      }
    })
    expect(result.showToast.mock.calls).toEqual([[message, 1500]])
    expect(result.onError).toHaveBeenCalledOnce()
  })

  it('handles a page-local missing grant without dispatching a pick', async () => {
    const result = await attach({ routeGrants: ['navigate', 'storage'] })
    expect(result.showToast.mock.calls).toEqual([['Media attachments unavailable here', 1500]])
    expect(result.bridge.readToShell().some((frame) => frame.type === 'request')).toBe(false)
  })

  it('keeps cancellation silent through the page bridge and upload hook', async () => {
    const result = await attach({ serveNativeVerb: async () => ({ items: [] }) })
    expect(result.showToast).not.toHaveBeenCalled()
    expect(result.onError).not.toHaveBeenCalled()
    expect(result.bridge.hostDiagnostics).toEqual([])
  })
})
