import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  HostSessionNativeChatOperations,
  HostSessionNativeChatTarget
} from './host-session-native-chat-operations'
import { resetMobileNativeChatStaleInputForTests } from './mobile-native-chat-stale-input'
import { useMobileNativeChatImageAttachments } from './use-mobile-native-chat-image-attachments'

vi.mock('./mobile-image-source-picker', () => ({
  pickMobileImage: vi.fn(),
  ImageLibraryPermissionError: class ImageLibraryPermissionError extends Error {}
}))

const TARGET: HostSessionNativeChatTarget = {
  workspaceId: 'workspace',
  agent: 'codex',
  sessionId: 'native_chat_session',
  transcriptPath: null,
  terminalId: 'terminal',
  clientId: null
}
const REFERENCE = `native_chat_image_0_${'01'.repeat(16)}`
const PREVIEW = 'data:image/jpeg;base64,preview'

type HookArgs = Parameters<typeof useMobileNativeChatImageAttachments>[0]
type Hook = ReturnType<typeof useMobileNativeChatImageAttachments>

describe('hosted native-chat image attachments', () => {
  let renderer: ReactTestRenderer | null = null
  let hook: Hook | null = null

  function Harness({ args }: { args: HookArgs }): null {
    hook = useMobileNativeChatImageAttachments(args)
    return null
  }

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    resetMobileNativeChatStaleInputForTests()
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    hook = null
    resetMobileNativeChatStaleInputForTests()
  })

  function mount(args: HookArgs): void {
    const warning = vi.spyOn(console, 'error').mockImplementation((value) => {
      if (typeof value !== 'string' || !value.includes('react-test-renderer is deprecated')) {
        console.warn(value)
      }
    })
    try {
      act(() => {
        renderer = create(createElement(Harness, { args }))
      })
    } finally {
      warning.mockRestore()
    }
  }

  it('attaches, pastes, and releases only the opaque hosted reference', async () => {
    const attachImage = vi.fn().mockResolvedValue({
      status: 'accepted',
      attachment: { reference: REFERENCE, previewUri: PREVIEW }
    })
    const pasteImages = vi.fn().mockResolvedValue(true)
    const releaseImages = vi.fn().mockResolvedValue(undefined)
    const baseSend = vi.fn().mockResolvedValue('accepted')
    const operations = imageOperations({ attachImage, pasteImages, releaseImages })
    mount(baseArgs(operations, baseSend))

    await act(async () => {
      await hook!.attachImage('library')
    })
    expect(hook!.attachments).toEqual([{ id: 'img-1', path: REFERENCE, previewUri: PREVIEW }])

    await act(async () => {
      expect(await hook!.sendNativeChat('inspect')).toBe(true)
    })
    expect(pasteImages).toHaveBeenCalledWith(TARGET, [REFERENCE], expect.any(Number), true)
    expect(baseSend).toHaveBeenCalledWith('inspect', [PREVIEW], expect.any(Number))
    expect(releaseImages).toHaveBeenCalledWith(TARGET, [REFERENCE])
    expect(hook!.attachments).toEqual([])
    expect(JSON.stringify({ attachImage, pasteImages, releaseImages })).not.toContain('/private/')
  })

  it('keeps a rejected hosted paste retryable without submitting text', async () => {
    const pasteImages = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const baseSend = vi.fn().mockResolvedValue('accepted')
    const operations = imageOperations({
      attachImage: acceptedAttachment,
      pasteImages
    })
    mount(baseArgs(operations, baseSend))
    await act(async () => {
      await hook!.attachImage('files')
    })

    await act(async () => {
      expect(await hook!.sendNativeChat('inspect')).toBe(false)
    })
    expect(baseSend).not.toHaveBeenCalled()
    expect(hook!.attachments).toHaveLength(1)

    await act(async () => {
      expect(await hook!.sendNativeChat('inspect')).toBe(true)
    })
    expect(pasteImages).toHaveBeenCalledTimes(2)
    expect(baseSend).toHaveBeenCalledOnce()
    expect(hook!.attachments).toEqual([])
  })

  it('heals after an ambiguous hosted image submit before later plain text', async () => {
    const prepareCommit = vi.fn().mockResolvedValue(true)
    const releaseImages = vi.fn().mockResolvedValue(undefined)
    const baseSend = vi.fn().mockResolvedValueOnce('unknown').mockResolvedValueOnce('accepted')
    const operations = imageOperations({
      attachImage: acceptedAttachment,
      pasteImages: vi.fn().mockResolvedValue(true),
      prepareCommit,
      releaseImages
    })
    mount(baseArgs(operations, baseSend))
    await act(async () => {
      await hook!.attachImage('library')
    })

    await act(async () => {
      expect(await hook!.sendNativeChat('inspect')).toBe(true)
    })
    expect(hook!.attachments).toEqual([])
    expect(releaseImages).toHaveBeenCalledWith(TARGET, [REFERENCE])

    await act(async () => {
      expect(await hook!.sendNativeChat('later')).toBe(true)
    })
    expect(prepareCommit).toHaveBeenCalledWith(TARGET, expect.any(Number))
    expect(baseSend).toHaveBeenNthCalledWith(2, 'later', undefined, expect.any(Number))
  })

  it('releases an unsent reference when its chip is removed', async () => {
    const releaseImages = vi.fn().mockResolvedValue(undefined)
    const operations = imageOperations({
      attachImage: acceptedAttachment,
      releaseImages
    })
    mount(baseArgs(operations, vi.fn().mockResolvedValue('accepted')))
    await act(async () => {
      await hook!.attachImage('library')
    })

    act(() => {
      hook!.removeAttachment('img-1')
    })
    expect(releaseImages).toHaveBeenCalledWith(TARGET, [REFERENCE])
    expect(hook!.attachments).toEqual([])
  })
})

function baseArgs(
  operations: HostSessionNativeChatOperations,
  baseSend: HookArgs['baseSend']
): HookArgs {
  return {
    client: null,
    activeHandleRef: { current: 'terminal' },
    deviceTokenRef: { current: null },
    getActiveWorktreeConnectionId: async () => null,
    connState: 'connected',
    scopeKey: 'host\0workspace\0tab',
    enabled: true,
    operations,
    targetRef: { current: TARGET },
    showToast: vi.fn(),
    onSendError: vi.fn(),
    baseSend,
    readSeededLaunchDraft: () => null,
    sleep: async () => {}
  }
}

function imageOperations(
  overrides: Partial<HostSessionNativeChatOperations>
): HostSessionNativeChatOperations {
  return {
    readability: async () => true,
    subscribe: () => () => {},
    read: async () => ({ messages: [] }),
    sendMessage: async () => 'accepted',
    prepareCommit: async () => true,
    respond: async () => 'accepted',
    stop: async () => 'accepted',
    searchFiles: async () => [],
    openFile: async () => {},
    ...overrides
  }
}

function acceptedAttachment() {
  return Promise.resolve({
    status: 'accepted' as const,
    attachment: { reference: REFERENCE, previewUri: PREVIEW }
  })
}
