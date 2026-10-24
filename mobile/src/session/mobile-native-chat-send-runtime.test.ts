import { draftWriteParamsSchema } from '../mobile-web-shell/bridge/bridge-draft-storage'
import { useMobileNativeChatMessageSend } from './use-mobile-native-chat-message-send'
import { useMobileNativeChatImageAttachments } from './use-mobile-native-chat-image-attachments'
import { copyMobileQueuedMessageToDraft } from './mobile-native-chat-queued-extraction'
import {
  readMobileNativeChatDraft,
  resetMobileNativeChatDraftStoreForTests,
  captureMobileChatDraftOwner,
  updateMobileNativeChatDraftImages
} from './mobile-native-chat-draft-store'
import { publishMobileChatDraftStorage } from './mobile-native-chat-draft-storage'
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import type { MobileNativeChatSendOutcome } from './mobile-native-chat-send'
import { useMobileNativeChatDrafts } from './use-mobile-native-chat-drafts'
import { useMobileStructuredSendWithOutcome } from './use-mobile-structured-send-with-outcome'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { EMPTY_STRUCTURED_AGENT_SESSION } from '../../../src/shared/structured-agent-session-reducer'
import { useMobileStructuredNativeChatSendBridge } from './use-mobile-structured-native-chat-send-bridge'

import { createFakeBridgePortPair } from '../mobile-web-shell/bridge/bridge-port-pair-test-harness'
import { installPageChatDraftStorage } from '../mobile-web-shell/bridge/page-draft-storage'

vi.mock('../platform/media-picker', () => ({
  useMediaPicker: () => ({ pickImages: async () => [] })
}))
let imageApi: ReturnType<typeof useMobileNativeChatImageAttachments>
it.each(['before-post', 'command-pending', 'image-pending', 'terminal-clear'] as const)(
  'actual page bridge retirement: %s',
  async (schedule) => {
    const scope = 'host-a\0workspace\0tab'
    const pair = createFakeBridgePortPair({
      serveNativeVerb: async (verb, params) => {
        if (verb === 'native.storage.read') {
          return { value: null }
        }
        if (verb === 'native.storage.write') {
          const part = draftWriteParamsSchema.parse(params)
          return { committed: part.index + 1 === part.total }
        }
        throw new Error(verb)
      }
    })
    await pair.flush()
    installPageChatDraftStorage(pair.client)
    const client = pair.client
    const onSendError = vi.fn()
    const messages: NativeChatMessage[] = []
    const stateRef = { current: { ...EMPTY_STRUCTURED_AGENT_SESSION, fence: 1 } }
    let renderer: ReactTestRenderer | undefined
    let api: ReturnType<typeof useMobileNativeChatDrafts> &
      ReturnType<typeof useMobileStructuredNativeChatSendBridge>
    function Harness() {
      const drafts = useMobileNativeChatDrafts({
        hostId: 'host-a',
        worktreeId: 'workspace',
        tabId: 'tab',
        sessionId: 'session',
        messages,
        transcriptSettled: true
      })
      const sendStructured = useMobileStructuredSendWithOutcome({
        agent: 'codex',
        client,
        sessionId: 'session',
        enabled: true,
        queueCapable: false,
        commandsWait: false,
        stateRef,
        stopping: false,
        accept: vi.fn(),
        hold: vi.fn(),
        commandPending: { current: false },
        controller: {
          snapshot: [],
          setOption: async () => false,
          invokeAction: async () => false,
          conversationCommands: ['compact']
        },
        onSendError
      })
      api = {
        ...drafts,
        ...useMobileStructuredNativeChatSendBridge({
          agent: 'codex',
          ...drafts,
          authoringReady: drafts.draftAuthoringReady,
          sendStructured,
          onSendError
        })
      }
      const terminal = useMobileNativeChatMessageSend({
        client,
        authoringReady: drafts.draftAuthoringReady,
        enabled: true,
        handleRef: { current: 'term-1' },
        deviceTokenRef: { current: null },
        agentRef: { current: 'claude' },
        commandSendRef: { current: () => {} },
        ...drafts,
        readSeededLaunchDraftSeed: () => null,
        onSendError
      })
      if (schedule === 'terminal-clear') {
        api = { ...drafts, ...terminal }
      }
      imageApi = useMobileNativeChatImageAttachments({
        client,
        activeHandleRef: { current: null },
        deviceTokenRef: { current: null },
        getActiveWorktreeConnectionId: async () => null,
        connState: 'connected',
        scopeKey: scope,
        enabled: true,
        structuredNativeChat: true,
        showToast: vi.fn(),
        onSendError,
        baseSend: api.sendWithOutcome,
        readSeededLaunchDraft: () => null
      })
      return null
    }

    try {
      await act(async () => {
        renderer = create(createElement(Harness))
        await pair.flush()
      })
      expect(api!.draftAuthoringReady).toBe(true)
      const text =
        schedule === 'before-post'
          ? '$review'
          : schedule === 'image-pending'
            ? 'look'
            : schedule === 'terminal-clear'
              ? 'terminal prompt'
              : '/compact'
      await act(
        schedule === 'before-post' || schedule === 'image-pending'
          ? async () => {
              const p = copyMobileQueuedMessageToDraft(scope, {
                messageId: 'picked',
                position: 1,
                state: 'waiting',
                body: {
                  kind: 'message',
                  role: 'user',
                  blocks: [
                    { type: 'text', text },
                    ...(schedule === 'image-pending'
                      ? [{ type: 'image-ref' as const, url: 'https://example.com/photo.png' }]
                      : [])
                  ],
                  ...(schedule === 'before-post'
                    ? { skills: [{ name: 'review', path: '/a/review/SKILL.md' }] }
                    : {})
                }
              })
              await pair.flush()
              await p
            }
          : async () => {
              api!.setComposerText(text)
            }
      )
      let pending: Promise<MobileNativeChatSendOutcome | boolean>
      await act(async () => {
        pending =
          schedule === 'image-pending' ? imageApi.sendNativeChat(text) : api!.sendWithOutcome(text)
        if (schedule === 'terminal-clear') {
          await pair.flush()
        }
        expect(readMobileNativeChatDraft(scope).text).toBe('')
        if (schedule !== 'before-post') {
          await pair.flush()
          expect(pair.rpc.requests[0]?.method).toBe(
            schedule === 'command-pending'
              ? 'agentSession.conversationCommand'
              : schedule === 'terminal-clear'
                ? 'terminal.send'
                : 'agentSession.send'
          )
        }
        pair.client.close()
        if (schedule === 'image-pending') {
          updateMobileNativeChatDraftImages(
            captureMobileChatDraftOwner(scope),
            (current) => [
              ...current.map((image) => ({ ...image, previewUri: 'data:image/png;base64,eA==' })),
              { id: 'later', path: '/later.png', previewUri: 'file:///later.png' }
            ],
            true
          )
        }
        await pair.flush()
        if (schedule === 'before-post') {
          expect(pair.rpc.requests).toHaveLength(0)
        }
        expect(await pending).toBe(
          schedule === 'before-post' || schedule === 'terminal-clear'
            ? 'rejected'
            : schedule === 'command-pending'
              ? 'unknown'
              : true
        )
      })
      if (schedule === 'image-pending') {
        expect(readMobileNativeChatDraft(scope).images.map((image) => image.id)).toEqual(['later'])
      } else {
        expect(readMobileNativeChatDraft(scope).text).toBe(text)
      }
      if (schedule === 'before-post') {
        expect(readMobileNativeChatDraft(scope).skills).toEqual([
          { name: 'review', path: '/a/review/SKILL.md' }
        ])
      }
    } finally {
      pair.client.close()
      act(() => renderer?.unmount())
      resetMobileNativeChatDraftStoreForTests()
      publishMobileChatDraftStorage(null)
    }
  }
)
