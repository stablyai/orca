import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileNativeChatSendOutcome } from './mobile-native-chat-send'
import { useMobileNativeChatAsyncReply } from './use-mobile-native-chat-async-reply'
import { useMobileNativeChatMessageSend } from './use-mobile-native-chat-message-send'
import { useMobileNativeChatDrafts } from './use-mobile-native-chat-drafts'
import { resetMobileNativeChatDraftStoreForTests } from './mobile-native-chat-draft-store'
import { resetMobileNativeChatTerminalWritesForTests } from './mobile-native-chat-terminal-write-lock'

const transport = vi.hoisted(() => ({
  heal: vi.fn<() => Promise<boolean>>(),
  clear: vi.fn<() => Promise<boolean>>(),
  send: vi.fn<() => Promise<MobileNativeChatSendOutcome>>()
}))
vi.mock('./mobile-native-chat-stale-input', () => ({
  healMobileNativeChatStaleInput: transport.heal
}))
vi.mock('./mobile-native-chat-send', () => ({
  clearMobileNativeChatInput: transport.clear,
  sendMobileNativeChatMessageWithOutcome: transport.send,
  typeMobileNativeChatCommandWithOutcome: () => {
    throw new Error('Answer must not be a command')
  },
  openMobileNativeChatSendBudget: () => Date.now() + 15_000,
  MOBILE_NATIVE_CHAT_SEND_TIMEOUT_MS: 15_000,
  MOBILE_NATIVE_CHAT_MIN_WRITE_TIMEOUT_MS: 2_000
}))

const client: RpcClient = {
  sendRequest: async () => {
    throw new Error('Unexpected RPC')
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
const resolved = vi.fn()
const stopAgent = vi.fn()
const sendError = vi.fn()
let tree: ReactTestRenderer | undefined
let latest:
  | {
      reply: ReturnType<typeof useMobileNativeChatAsyncReply>
      drafts: ReturnType<typeof useMobileNativeChatDrafts>
    }
  | undefined

type Props = { scope: string; disabled?: boolean; structured?: boolean }
const structuredSend = vi.fn<NonNullable<Parameters<typeof useMobileNativeChatAsyncReply>[2]>>()
/** Exercises real terminal sends and drafts, with a separate stub for structured replies. */
function Screen({ scope, disabled = false, structured = false }: Props) {
  const drafts = useMobileNativeChatDrafts({
    hostId: scope,
    worktreeId: 'workspace',
    tabId: 'tab',
    sessionId: 'session',
    messages: [],
    chatActive: true,
    transcriptLoading: false,
    transcriptSettled: true
  })
  const sender = useMobileNativeChatMessageSend({
    client,
    enabled: true,
    handleRef: { current: `terminal-${scope}` },
    deviceTokenRef: { current: 'device' },
    agentRef: { current: 'codex' },
    commandSendRef: { current: () => {} },
    captureSendOrigin: drafts.captureSendOrigin,
    readSeededLaunchDraftSeed: drafts.readSeededLaunchDraftSeed,
    clearDraftForSend: drafts.clearDraftForSend,
    restoreRejectedDraft: drafts.restoreRejectedDraft,
    acceptSend: drafts.acceptSend,
    holdUnconfirmedSend: drafts.holdUnconfirmedSend,
    onSendError: sendError
  })
  latest = {
    drafts,
    reply: useMobileNativeChatAsyncReply(
      scope,
      disabled,
      structured ? structuredSend : null,
      sender.answerQuestion,
      resolved,
      stopAgent
    )
  }
  return null
}
function current() {
  if (!latest) {
    throw new Error('Screen is not mounted')
  }
  return latest
}
/** Starts with an unfinished composer draft so replies can be checked for accidental edits. */
async function mount(props: Props = { scope: 'host-a' }) {
  await act(async () => {
    tree = create(<Screen {...props} />)
  })
  await act(async () => {
    current().drafts.setComposerText('unfinished composer draft')
  })
}
beforeEach(() => {
  vi.resetAllMocks()
  transport.heal.mockResolvedValue(true)
  transport.clear.mockResolvedValue(true)
  transport.send.mockResolvedValue('accepted')
  structuredSend.mockResolvedValue('accepted')
})
afterEach(async () => {
  await act(async () => tree?.unmount())
  tree = undefined
  latest = undefined
  resetMobileNativeChatDraftStoreForTests()
  resetMobileNativeChatTerminalWritesForTests()
})

it.each(['accepted', 'rejected', 'unknown'] as const)(
  'preserves the composer on terminal outcome %s and never retries automatically',
  async (outcome) => {
    transport.send.mockResolvedValue(outcome)
    await mount()
    await act(async () => {
      expect(await current().reply.reply.send('Which branch?\nrelease')).toBe(
        outcome === 'accepted'
      )
    })
    expect(current().drafts.composerText).toBe('unfinished composer draft')
    expect(transport.send).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        terminal: 'terminal-host-a',
        text: 'Which branch?\nrelease',
        requireWriteSettlement: true
      })
    )
    expect(resolved).toHaveBeenCalledTimes(outcome === 'accepted' ? 1 : 0)
  }
)

it.each(['heal', 'clear'] as const)(
  'cancels a terminal reply after a delayed %s when input ownership changes',
  async (stage) => {
    const wait = Promise.withResolvers<boolean>()
    transport[stage].mockReturnValueOnce(wait.promise)
    await mount()
    let sending: boolean | Promise<boolean> = false
    await act(async () => {
      sending = current().reply.reply.send('answer')
    })
    await act(async () => {
      tree?.update(<Screen scope="host-a" disabled />)
    })
    await act(async () => {
      wait.resolve(true)
      expect(await sending).toBe(false)
    })
    expect(transport.clear).toHaveBeenCalledTimes(stage === 'heal' ? 0 : 1)
    expect(transport.send).not.toHaveBeenCalled()
    expect(resolved).not.toHaveBeenCalled()
    expect(current().drafts.composerText).toBe('unfinished composer draft')
    await act(async () => {
      tree?.update(<Screen scope="host-a" />)
    })
    await act(async () => {
      expect(await current().reply.reply.send('try again')).toBe(true)
    })
  }
)

it.each(['host', 'stop', 'unmount'] as const)(
  'does not write the reply body after %s during a slow clear',
  async (change) => {
    const wait = Promise.withResolvers<boolean>()
    transport.clear.mockReturnValueOnce(wait.promise)
    await mount()
    const oldSend = current().reply.reply.send
    let sending: boolean | Promise<boolean> = false
    await act(async () => {
      sending = oldSend('answer')
    })
    await act(async () => {
      if (change === 'host') {
        tree?.update(<Screen scope="host-b" />)
      } else if (change === 'stop') {
        current().reply.stop()
      } else {
        tree?.unmount()
        tree = undefined
      }
    })
    await act(async () => {
      wait.resolve(true)
      expect(await sending).toBe(false)
    })
    expect(transport.send).not.toHaveBeenCalled()
    expect(resolved).not.toHaveBeenCalled()
    if (change !== 'stop') {
      expect(await oldSend('stale answer')).toBe(false)
    } else {
      expect(stopAgent).toHaveBeenCalledTimes(1)
    }
  }
)

it('does not notify the replacement screen when an old host acknowledges a sent body', async () => {
  const wait = Promise.withResolvers<MobileNativeChatSendOutcome>()
  transport.send.mockReturnValueOnce(wait.promise)
  await mount()
  let sending: boolean | Promise<boolean> = false
  await act(async () => {
    sending = current().reply.reply.send('answer')
  })
  await act(async () => {
    tree?.update(<Screen scope="host-b" />)
  })
  await act(async () => {
    current().drafts.setComposerText('new host draft')
  })
  await act(async () => {
    wait.resolve('accepted')
    expect(await sending).toBe(true)
  })
  expect(resolved).not.toHaveBeenCalled()
  expect(current().drafts.composerText).toBe('new host draft')
  expect(transport.send).toHaveBeenCalledTimes(1)
})

it.each(['accepted', 'rejected', 'unknown', 'queued'] as const)(
  'uses immediate structured delivery and only completes on accepted: %s',
  async (outcome) => {
    structuredSend.mockResolvedValue(outcome)
    await mount({ scope: 'host-a', structured: true })
    await act(async () => {
      expect(await current().reply.reply.send('answer')).toBe(outcome === 'accepted')
    })
    expect(structuredSend).toHaveBeenCalledExactlyOnceWith(
      'answer',
      undefined,
      undefined,
      undefined,
      { immediate: true }
    )
    expect(transport.send).not.toHaveBeenCalled()
    expect(current().drafts.composerText).toBe('unfinished composer draft')
    expect(resolved).toHaveBeenCalledTimes(outcome === 'accepted' ? 1 : 0)
  }
)
