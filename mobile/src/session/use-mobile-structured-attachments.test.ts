import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type * as MobileNativeChatImageAttachment from './mobile-native-chat-image-attachment'
import { uploadMobileNativeChatImages } from './mobile-native-chat-image-attachment'
import { useMobileStructuredAttachments } from './use-mobile-structured-attachments'

vi.mock('./mobile-native-chat-image-attachment', async (importOriginal) => {
  const original = await importOriginal<typeof MobileNativeChatImageAttachment>()
  return { ...original, uploadMobileNativeChatImages: vi.fn() }
})
vi.mock('./mobile-image-source-picker', () => ({
  ImageLibraryPermissionError: class ImageLibraryPermissionError extends Error {},
  pickMobileImages: vi.fn()
}))

describe('useMobileStructuredAttachments', () => {
  let renderer: ReactTestRenderer | null = null
  let controller: ReturnType<typeof useMobileStructuredAttachments> | null = null
  const onError = vi.fn()

  function Probe(): null {
    controller = useMobileStructuredAttachments({
      client: {} as RpcClient,
      sessionId: 'mobile_1',
      getConnectionId: async () => null,
      onError
    })
    return null
  }

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    onError.mockReset()
    vi.mocked(uploadMobileNativeChatImages).mockReset()
    act(() => {
      renderer = create(createElement(Probe))
    })
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    controller = null
  })

  it('retains completed uploads when a later selected image fails', async () => {
    vi.mocked(uploadMobileNativeChatImages).mockImplementation(async (_source, deps) => {
      deps.onImageUploaded?.({ path: '/host/first.png', previewUri: 'file:///first.png' })
      throw new Error('second upload failed')
    })

    await act(async () => {
      await controller!.attach('library')
    })

    expect(controller!.attachments).toEqual([
      { id: 'img-1', path: '/host/first.png', previewUri: 'file:///first.png' }
    ])
    expect(onError).toHaveBeenCalledWith('Attach failed')
  })
})
