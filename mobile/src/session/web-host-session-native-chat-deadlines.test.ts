import { afterEach, describe, expect, it, vi } from 'vitest'
import { MOBILE_WEB_SHELL_NATIVE_CHAT_PASTE_FOLLOWED_BY_TEXT_FEATURE } from '../../../src/shared/mobile-web/bridge-contract'
import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import type { HostSessionNativeChatTarget } from './host-session-native-chat-operations'
import {
  isMobileNativeChatInputStale,
  markMobileNativeChatInputStale,
  resetMobileNativeChatStaleInputForTests
} from './mobile-native-chat-stale-input'
import { webHostSessionNativeChatOperations } from './web-host-session-native-chat-operations'

const TARGET: HostSessionNativeChatTarget = {
  workspaceId: 'workspace',
  agent: 'codex',
  sessionId: 'native_chat_session',
  transcriptPath: null,
  terminalId: 'terminal',
  clientId: null
}

afterEach(() => {
  vi.useRealTimers()
  resetMobileNativeChatStaleInputForTests()
})

describe('hosted native-chat deadlines', () => {
  it('propagates one absolute deadline into page bridge mutation timeouts', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    const sendMessage = vi.fn().mockResolvedValue({ outcome: 'accepted' })
    const respond = vi.fn().mockResolvedValue({ outcome: 'accepted' })
    const stop = vi.fn().mockResolvedValue({ outcome: 'accepted' })
    const client = {
      nativeChat: { sendMessage, respond, stop }
    } as unknown as MobileWebBridgeClient
    const operations = webHostSessionNativeChatOperations(client)

    await expect(operations.sendMessage(TARGET, 'hello', 20_000, true)).resolves.toBe('accepted')
    await expect(operations.respond(TARGET, '1', false, 20_000)).resolves.toBe('accepted')
    await expect(operations.stop(TARGET, 20_000)).resolves.toBe('accepted')

    expect(sendMessage).toHaveBeenCalledWith(
      {
        workspaceId: 'workspace',
        sessionId: 'native_chat_session',
        text: 'hello',
        deadline: 20_000,
        clearInputFirst: true
      },
      { timeoutMs: 10_000 }
    )
    expect(respond).toHaveBeenCalledWith(
      {
        workspaceId: 'workspace',
        sessionId: 'native_chat_session',
        text: '1',
        enter: false,
        deadline: 20_000
      },
      { timeoutMs: 10_000 }
    )
    expect(stop).toHaveBeenCalledWith(
      { workspaceId: 'workspace', sessionId: 'native_chat_session', deadline: 20_000 },
      { timeoutMs: 10_000 }
    )
  })

  it('rejects underfunded mutations before posting a bridge request', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    const sendMessage = vi.fn()
    const pasteImages = vi.fn()
    const client = {
      nativeChat: { sendMessage, pasteImages }
    } as unknown as MobileWebBridgeClient
    const operations = webHostSessionNativeChatOperations(client)

    await expect(operations.sendMessage(TARGET, 'hello', 11_999)).resolves.toBe('rejected')
    await expect(operations.pasteImages!(TARGET, ['opaque-image'], 11_999)).resolves.toBe(false)
    expect(sendMessage).not.toHaveBeenCalled()
    expect(pasteImages).not.toHaveBeenCalled()
  })

  it('forwards the following-text hint only when typed text follows the paste', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    const pasteImages = vi.fn().mockResolvedValue({ pasted: true })
    const operations = webHostSessionNativeChatOperations(
      pasteImagesClient(pasteImages, [MOBILE_WEB_SHELL_NATIVE_CHAT_PASTE_FOLLOWED_BY_TEXT_FEATURE])
    )

    await expect(operations.pasteImages!(TARGET, ['opaque-image'], 20_000, true)).resolves.toBe(
      true
    )
    await expect(operations.pasteImages!(TARGET, ['opaque-image'], 20_000, false)).resolves.toBe(
      true
    )

    expect(pasteImages).toHaveBeenNthCalledWith(
      1,
      { ...pastePayload(), followedByText: true },
      { timeoutMs: 10_000 }
    )
    expect(pasteImages).toHaveBeenNthCalledWith(2, pastePayload(), { timeoutMs: 10_000 })
  })

  // Why: page->shell payloads are strict, so an unadvertised key is `invalid_request` on the whole
  // paste — the image never lands at all, which is far worse than a missing trailing space.
  it('withholds the following-text hint from a shell that does not advertise it', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    const pasteImages = vi.fn().mockResolvedValue({ pasted: true })

    for (const features of [[], ['nativeChat.pasteImages.somethingElse.v1']]) {
      const operations = webHostSessionNativeChatOperations(
        pasteImagesClient(pasteImages, features)
      )
      await expect(operations.pasteImages!(TARGET, ['opaque-image'], 20_000, true)).resolves.toBe(
        true
      )
    }

    expect(pasteImages).toHaveBeenCalledTimes(2)
    for (const [payload] of pasteImages.mock.calls) {
      expect(payload).not.toHaveProperty('followedByText')
    }
  })

  it('clears a stale hosted composer only after the shell accepts preparation', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    const prepareCommit = vi.fn().mockResolvedValue({ prepared: true })
    const client = {
      nativeChat: { prepareCommit }
    } as unknown as MobileWebBridgeClient
    const operations = webHostSessionNativeChatOperations(client)
    markMobileNativeChatInputStale('terminal')

    await expect(operations.prepareCommit(TARGET, 20_000)).resolves.toBe(true)
    expect(prepareCommit).toHaveBeenCalledWith(
      { workspaceId: 'workspace', sessionId: 'native_chat_session', deadline: 20_000 },
      { timeoutMs: 10_000 }
    )
    expect(isMobileNativeChatInputStale('terminal')).toBe(false)
  })

  it('maps the validated attach response into the shared discriminated result', async () => {
    const attachImage = vi.fn().mockResolvedValue({
      status: 'accepted',
      attachment: {
        reference: `native_chat_image_0_${'01'.repeat(16)}`,
        previewUri: 'data:image/jpeg;base64,preview'
      }
    })
    const operations = webHostSessionNativeChatOperations({
      nativeChat: { attachImage }
    } as unknown as MobileWebBridgeClient)

    await expect(operations.attachImage!(TARGET, 'library')).resolves.toEqual({
      status: 'accepted',
      attachment: {
        reference: `native_chat_image_0_${'01'.repeat(16)}`,
        previewUri: 'data:image/jpeg;base64,preview'
      }
    })
  })
})

function pasteImagesClient(
  pasteImages: ReturnType<typeof vi.fn>,
  shellFeatures: readonly string[]
): MobileWebBridgeClient {
  return {
    nativeChat: { pasteImages },
    supportsShellFeature: (feature: string) => shellFeatures.includes(feature)
  } as unknown as MobileWebBridgeClient
}

function pastePayload(): Record<string, unknown> {
  return {
    workspaceId: 'workspace',
    sessionId: 'native_chat_session',
    references: ['opaque-image'],
    deadline: 20_000
  }
}
