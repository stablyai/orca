import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendReturnedDraftText } from '../../../../../src/shared/returned-draft-text'
import { stubRpcClient } from '../../../transport/rpc/rpc-client-test-stub'
import {
  clearMobileNativeChatDraftForSend,
  closeMobileNativeChatTabDraft,
  readMobileNativeChatDraftEditGeneration,
  setMobileNativeChatDraftText,
  useMobileNativeChatDraft
} from './mobile-native-chat-draft-store'
import { mobileNativeChatDraftDestination } from './mobile-native-chat-draft-inputs'
import type { PendingNativeChatFile } from './mobile-native-chat-file-attachment'
import { useMobileNativeChatMessageSend } from '../transcript/use-mobile-native-chat-message-send'
import { useMobileNativeChatImageAttachments } from './use-mobile-native-chat-image-attachments'

const wire = vi.hoisted((): { texts: string[]; outcome: string } => ({
  texts: [],
  outcome: 'accepted'
}))
vi.mock('./mobile-native-chat-send', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./mobile-native-chat-send')>()),
  readMobileNativeChatInputClear: async () => null,
  clearMobileNativeChatInput: async () => true,
  sendMobileNativeChatMessageWithOutcome: async (args: { text: string }) => {
    wire.texts.push(args.text)
    return wire.outcome
  }
}))
vi.mock('./mobile-native-chat-stale-input', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./mobile-native-chat-stale-input')>()),
  healMobileNativeChatStaleInput: async () => true
}))

vi.mock('../../../platform/media-picker', () => ({
  useMediaPicker: () => ({ pickImages: vi.fn() })
}))

const SCOPE = 'h\0w\0tab-file-send'
const RAW = 'Разбери видео'
const FILE: PendingNativeChatFile = {
  id: 'f1',
  name: 'lenta 1.mp4',
  mime: 'video/mp4',
  byteLength: 10,
  sentBytes: 10,
  path: '/tmp/orca-paste-1/lenta 1.mp4'
}

/** The pasted text without bracketed-paste framing, when the send used it. */
function pasteBody(bytes: string): string {
  return bytes.replace('\u001b[200~', '').replace('\u001b[201~', '')
}

describe('terminal send with a stored file', () => {
  let renderer: ReactTestRenderer | null = null
  let draft = ''
  let send!: (text: string) => Promise<boolean>
  const onFilesSent = vi.fn()

  function Harness(): null {
    draft = useMobileNativeChatDraft(SCOPE)
    const message = useMobileNativeChatMessageSend({
      client: stubRpcClient(),
      enabled: true,
      handleRef: { current: 'term-1' },
      deviceTokenRef: { current: null },
      agentRef: { current: 'claude' },
      commandSendRef: { current: () => {} },
      captureSendOrigin: (text) => ({
        draftKey: SCOPE,
        draftDestination: mobileNativeChatDraftDestination(SCOPE),
        draftEditGeneration: readMobileNativeChatDraftEditGeneration(SCOPE),
        pendingKey: null,
        normalizedText: text,
        boundary: { afterMessageId: null, afterMessageTimestamp: null },
        sentAt: 0
      }),
      readSeededLaunchDraftSeed: () => null,
      clearDraftForSend: (origin, text) =>
        clearMobileNativeChatDraftForSend(
          origin.draftDestination,
          origin.draftEditGeneration,
          text
        ),
      restoreRejectedDraft: (origin, text, options) =>
        setMobileNativeChatDraftText(origin.draftDestination, (current) =>
          appendReturnedDraftText(current, text, options)
        ),
      acceptSend: () => {},
      holdUnconfirmedSend: () => {},
      onSendError: () => {}
    })
    send = useMobileNativeChatImageAttachments({
      client: stubRpcClient(),
      activeHandleRef: { current: 'term-1' },
      deviceTokenRef: { current: null },
      getActiveWorktreeConnectionId: async () => null,
      connState: 'connected',
      scopeKey: SCOPE,
      enabled: true,
      structuredNativeChat: false,
      showToast: vi.fn(),
      onSendError: vi.fn(),
      baseSend: message.sendWithOutcome,
      files: [FILE],
      onFilesSent,
      readSeededLaunchDraft: () => null,
      sleep: async () => {}
    }).sendNativeChat
    return null
  }

  beforeEach(() => {
    wire.texts = []
    wire.outcome = 'accepted'
    onFilesSent.mockReset()
    setMobileNativeChatDraftText(SCOPE, RAW)
    act(() => {
      renderer = create(createElement(Harness))
    })
  })
  afterEach(() => {
    act(() => renderer?.unmount())
    closeMobileNativeChatTabDraft(SCOPE)
  })

  it('clears the typed draft once the send is accepted, with the reference on the wire only', async () => {
    await act(async () => {
      await send(RAW)
    })
    expect(wire.texts).toHaveLength(1)
    expect(wire.texts[0]).toMatch(/Разбери видео\s@"\/tmp\/orca-paste-1\/lenta 1\.mp4"/)
    expect(draft).toBe('')
    expect(onFilesSent).toHaveBeenCalledTimes(1)
  })

  // Claude Code opens its file picker on an @token under the cursor, and the separate Enter then
  // picks the suggestion instead of submitting; a trailing space closes the token first.
  it('ends the wire text with a space after the last @reference so Enter submits', async () => {
    await act(async () => {
      await send(RAW)
    })
    expect(pasteBody(wire.texts[0]!)).toMatch(/lenta 1\.mp4" $/)
  })

  it('keeps the closing space when the file is sent without text', async () => {
    setMobileNativeChatDraftText(SCOPE, '')
    await act(async () => {
      await send('')
    })
    expect(wire.texts).toHaveLength(1)
    expect(pasteBody(wire.texts[0]!)).toBe('@"/tmp/orca-paste-1/lenta 1.mp4" ')
  })

  it('hands a rejected send back as the typed text once, keeping the chip', async () => {
    wire.outcome = 'rejected'
    await act(async () => {
      await send(RAW)
    })
    expect(draft).toBe(RAW)
    expect(draft).not.toContain('@')
    expect(onFilesSent).not.toHaveBeenCalled()
  })
})
