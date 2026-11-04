import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import type { RpcClient } from '../../../transport/rpc-client'
import type { RpcResponse, RpcSuccess } from '../../../transport/types'
import { useMobileNativeChatDrafts } from './use-mobile-native-chat-drafts'
import {
  useMobileNativeChatDraft,
  resetMobileNativeChatDraftStoreForTests
} from './mobile-native-chat-draft-store'
import { useMobileNativeChatMessageSend } from '../transcript/use-mobile-native-chat-message-send'
import { useMobileNativeChatImageAttachments } from './use-mobile-native-chat-image-attachments'

const pick = vi.hoisted(() => vi.fn())
vi.mock('../../../platform/media-picker', () => ({ useMediaPicker: () => ({ pickImages: pick }) }))

function ok(id: string, result: unknown): RpcSuccess {
  return { id, ok: true, result, _meta: { runtimeId: 'r' } }
}
const sendResult = (accepted: boolean) => ok('send', { send: { accepted } })
let renderer: ReactTestRenderer | null = null
let hook: ReturnType<typeof useMobileNativeChatImageAttachments> | null = null
afterEach(async () => {
  await act(async () => renderer?.unmount())
  renderer = null
  hook = null
  resetMobileNativeChatDraftStoreForTests()
})

it('preserves a refused image draft and does not clear the host after chip removal and text retry', async () => {
  pick.mockResolvedValue([{ base64: 'AAAA', uri: 'file:///a.jpg' }])
  const uploadReplies: RpcResponse[] = [
    {
      id: 'start',
      ok: false,
      error: { code: 'method_not_found', message: 'no' },
      _meta: { runtimeId: 'r' }
    },
    ok('save', '/tmp/a.png')
  ]
  const writes: unknown[] = []
  const client: RpcClient = {
    sendRequest: async (method, params) => {
      if (method === 'terminal.read') {
        return ok('read', { terminal: { draft: Array(16).fill('desktop draft').join('\n') } })
      }
      if (method === 'terminal.send') {
        writes.push(params)
        return sendResult(true)
      }
      const reply = uploadReplies.shift()
      if (!reply) {
        throw new Error(`Unexpected request: ${method}`)
      }
      return reply
    },
    subscribe: () => () => {},
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => 1,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }
  const onSendError = vi.fn()
  let edit: (text: string) => void = () => {}
  let text = ''
  function IntegratedComposer() {
    const drafts = useMobileNativeChatDrafts({
      hostId: 'cap-host',
      worktreeId: 'folder',
      tabId: 'cap-tab',
      sessionId: 'cap-session',
      messages: [],
      transcriptSettled: true
    })
    edit = drafts.setComposerText
    text = useMobileNativeChatDraft(drafts.draftKey)
    const sender = useMobileNativeChatMessageSend({
      client,
      enabled: true,
      handleRef: { current: 'term-1' },
      deviceTokenRef: { current: null },
      agentRef: { current: 'codex' },
      commandSendRef: { current: () => {} },
      ...drafts,
      onSendError
    })
    hook = useMobileNativeChatImageAttachments({
      client,
      agent: 'codex',
      activeHandleRef: { current: 'term-1' },
      deviceTokenRef: { current: null },
      getActiveWorktreeConnectionId: async () => null,
      connState: 'connected',
      enabled: true,
      showToast: () => {},
      onSendError,
      structuredNativeChat: false,
      readSeededLaunchDraft: drafts.readSeededLaunchDraft,
      scopeKey: drafts.draftKey,
      baseSend: sender.sendWithOutcome
    })
    return null
  }
  await act(async () => {
    renderer = create(createElement(IntegratedComposer))
  })
  await act(async () => {
    edit('caption')
    await hook!.attachImage('library')
  })
  let first = true
  await act(async () => {
    first = await hook!.sendNativeChat('caption')
  })
  expect(hook!.attachments).toHaveLength(1)
  await act(async () => {
    hook!.removeAttachment(hook!.attachments[0]!.id)
  })
  let retried = true
  await act(async () => {
    retried = await hook!.sendNativeChat('caption')
  })
  expect({ first, retried }).toEqual({ first: false, retried: false })
  expect(writes).toEqual([])
  expect(text).toBe('caption')
  expect(onSendError).toHaveBeenLastCalledWith('Message not sent')
})
