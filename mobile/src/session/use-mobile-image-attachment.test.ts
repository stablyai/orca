import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostSessionTerminalOperations } from './host-session-terminal-operations'
import { useMobileImageAttachment } from './use-mobile-image-attachment'

vi.mock('./mobile-image-attachment', () => ({
  attachMobileImageToTerminal: vi.fn()
}))

vi.mock('./mobile-image-source-picker', () => ({
  ImageLibraryPermissionError: class ImageLibraryPermissionError extends Error {},
  pickMobileImage: vi.fn()
}))

type AttachmentState = ReturnType<typeof useMobileImageAttachment>
type AttachImage = NonNullable<HostSessionTerminalOperations['attachImage']>

function terminalOperations(attachImage: AttachImage): HostSessionTerminalOperations {
  return {
    subscribe: vi.fn(() => () => {}),
    acknowledge: vi.fn(),
    sendInput: vi.fn(async () => true),
    sendQueryReply: vi.fn(async () => true),
    setDisplayMode: vi.fn(async () => true),
    clear: vi.fn(async () => true),
    rename: vi.fn(async () => true),
    attachImage
  }
}

describe('useMobileImageAttachment hosted adapter', () => {
  let renderer: ReactTestRenderer | null = null
  let state: AttachmentState | null = null
  const onSuccess = vi.fn()
  const onError = vi.fn()
  const showToast = vi.fn()

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    state = null
  })

  function Harness({ operations }: { operations: HostSessionTerminalOperations }): null {
    state = useMobileImageAttachment({
      client: null,
      activeHandle: 'page-tab-1',
      canSend: true,
      connState: 'connected',
      deviceTokenRef: { current: null },
      getActiveWorktreeConnectionId: async () => null,
      showToast,
      onSuccess,
      onError,
      terminalOperations: operations
    })
    return null
  }

  async function mount(operations: HostSessionTerminalOperations): Promise<void> {
    const original = console.error
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) {
        return
      }
      original(...args)
    })
    try {
      await act(async () => {
        renderer = create(createElement(Harness, { operations }))
      })
    } finally {
      consoleSpy.mockRestore()
    }
  }

  it('routes the unchanged Attach control through the hosted terminal stream', async () => {
    const attachImage = vi.fn<AttachImage>(async () => ({ status: 'accepted' }))
    await mount(terminalOperations(attachImage))

    await act(async () => {
      await state?.attachImage('library')
    })

    expect(attachImage).toHaveBeenCalledWith('page-tab-1', 'library')
    expect(onSuccess).toHaveBeenCalledOnce()
    expect(onError).not.toHaveBeenCalled()
    expect(state?.isAttaching).toBe(false)
  })

  it('keeps native permission denial behind the existing toast and error feedback', async () => {
    const attachImage = vi.fn<AttachImage>(async () => ({ status: 'permission-denied' }))
    await mount(terminalOperations(attachImage))

    await act(async () => {
      await state?.attachImage('library')
    })

    expect(onError).toHaveBeenCalledOnce()
    expect(showToast).toHaveBeenCalledWith('Photo permission denied', 1500)
  })

  it('reports the bounded upload result without exposing a host error', async () => {
    const attachImage = vi.fn<AttachImage>(async () => ({ status: 'too-large' }))
    await mount(terminalOperations(attachImage))

    await act(async () => {
      await state?.attachImage('files')
    })

    expect(onError).toHaveBeenCalledOnce()
    expect(showToast).toHaveBeenCalledWith('Image too large to attach', 1500)
  })

  it('treats a cancelled native picker as a quiet no-op', async () => {
    const attachImage = vi.fn<AttachImage>(async () => ({ status: 'cancelled' }))
    await mount(terminalOperations(attachImage))

    await act(async () => {
      await state?.attachImage('library')
    })

    expect(onSuccess).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
    expect(showToast).not.toHaveBeenCalled()
  })
})
