import type * as MobileNativeChatSendModule from '../mobile-native-chat-send'
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../../../transport/rpc-client'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'

const transport = vi.hoisted(() => ({
  heal: vi.fn<() => Promise<boolean>>(),
  clearInput: vi.fn<() => Promise<boolean>>(),
  send: vi.fn<() => Promise<'accepted' | 'rejected' | 'unknown'>>(),
  command: vi.fn(),
  error: vi.fn()
}))

vi.mock('../mobile-native-chat-stale-input', () => ({
  healMobileNativeChatStaleInput: transport.heal
}))
vi.mock('../mobile-native-chat-send', async (importOriginal) => ({
  ...(await importOriginal<typeof MobileNativeChatSendModule>()),
  healMobileNativeChatStaleInput: transport.heal,
  clearMobileNativeChatInput: transport.clearInput,
  sendMobileNativeChatMessageWithOutcome: transport.send,
  typeMobileNativeChatCommandWithOutcome: transport.command,
  openMobileNativeChatSendBudget: () => Date.now() + 15_000,
  MOBILE_NATIVE_CHAT_SEND_TIMEOUT_MS: 15_000,
  MOBILE_NATIVE_CHAT_MIN_WRITE_TIMEOUT_MS: 2_000
}))

import { useMobileNativeChatDrafts } from './use-mobile-native-chat-drafts'
import { useMobileNativeChatMessageSend } from '../transcript/use-mobile-native-chat-message-send'
import {
  resetMobileNativeChatDraftStoreForTests,
  useMobileNativeChatDraft
} from './mobile-native-chat-draft-store'

function deferred<T>() {
  let resolve: ((value: T) => void) | undefined
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve: (value: T) => resolve!(value) }
}

type HookState = {
  drafts: ReturnType<typeof useMobileNativeChatDrafts> & { composerText: string }
  sender: ReturnType<typeof useMobileNativeChatMessageSend>
}

const client: RpcClient = {
  sendRequest: async () => {
    throw new Error('Unexpected RPC: transport is mocked')
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

describe('mobile native-chat send across screen lifetimes', () => {
  let renderer: ReactTestRenderer | null = null
  let latest: HookState | null = null
  let transcript: NativeChatMessage[] = []
  let rerender = () => {}

  afterEach(async () => {
    await act(async () => renderer?.unmount())
    renderer = null
    latest = null
    transcript = []
    vi.useRealTimers()
    resetMobileNativeChatDraftStoreForTests()
    vi.clearAllMocks()
  })

  async function mount(scope: string, workingEpoch?: number) {
    function SessionScreen() {
      const drafts = useMobileNativeChatDrafts({
        hostId: 'r1-host',
        worktreeId: 'r1-workspace',
        tabId: scope,
        sessionId: 'r1-session',
        messages: transcript,
        chatActive: true,
        transcriptLoading: false,
        transcriptSettled: true
      })
      const sender = useMobileNativeChatMessageSend({
        client,
        enabled: true,
        handleRef: { current: 'r1-terminal' },
        deviceTokenRef: { current: 'r1-device' },
        agentRef: { current: 'claude' },
        commandSendRef: { current: () => {} },
        captureSendOrigin: (text: string, sentAt?: number) => {
          const origin = drafts.captureSendOrigin(text, sentAt)
          return origin && workingEpoch !== undefined
            ? { ...origin, queuedDuringWorkingEpoch: workingEpoch }
            : origin
        },
        readSeededLaunchDraftSeed: drafts.readSeededLaunchDraftSeed,
        clearDraftForSend: drafts.clearDraftForSend,
        restoreRejectedDraft: drafts.restoreRejectedDraft,
        acceptSend: drafts.acceptSend,
        holdUnconfirmedSend: drafts.holdUnconfirmedSend,
        onSendError: transport.error
      })
      const composerText = useMobileNativeChatDraft(drafts.draftKey)
      latest = { drafts: { ...drafts, composerText }, sender }
      return null
    }
    await act(async () => {
      renderer = create(createElement(SessionScreen))
    })
    rerender = () => renderer?.update(createElement(SessionScreen))
  }

  function current(): HookState {
    if (!latest) {
      throw new Error('No mounted screen')
    }
    return latest
  }

  async function edit(text: string) {
    await act(async () => current().drafts.setComposerText(text))
  }

  async function remount(scope: string) {
    await act(async () => renderer?.unmount())
    renderer = null
    latest = null
    await mount(scope)
    expect(current().drafts.getComposerEditGeneration()).toBe(0)
  }

  async function scenario(scope: string, shouldRemount: boolean, replacement: string) {
    const heal = deferred<boolean>()
    const delivery = deferred<'accepted'>()
    transport.heal.mockImplementation(() => heal.promise)
    transport.clearInput.mockResolvedValue(true)
    transport.send.mockImplementation(() => delivery.promise)
    await mount(scope)
    await edit('ping')
    const oldMount = current()
    const origin = oldMount.drafts.captureSendOrigin('ping')
    expect(origin?.draftEditGeneration).toBe(1)
    let originalSend: Promise<boolean> | undefined
    await act(async () => {
      originalSend = oldMount.sender.send('ping')
    })
    expect(transport.heal).toHaveBeenCalledTimes(1)
    expect(transport.send).not.toHaveBeenCalled()
    expect(current().drafts.composerText).toBe('ping')

    if (shouldRemount) {
      await remount(scope)
      expect(current()).not.toBe(oldMount)
      expect(current().drafts.composerText).toBe('ping')
    }
    await edit('replacement in progress')
    await edit(replacement)
    expect(current().drafts.composerText).toBe(replacement)
    const currentGeneration = current().drafts.getComposerEditGeneration()

    await act(async () => heal.resolve(true))
    expect(transport.clearInput).toHaveBeenCalledTimes(1)
    expect(transport.send).toHaveBeenCalledTimes(1)
    expect(transport.send).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'ping', terminal: 'r1-terminal' })
    )
    const afterHeal = current().drafts.composerText

    await act(async () => {
      delivery.resolve('accepted')
      expect(await originalSend).toBe(true)
    })
    const afterDelivery = current().drafts.composerText
    expect(current().drafts.getComposerEditGeneration()).toBe(currentGeneration)
    expect({ afterHeal, afterDelivery }).toEqual({
      afterHeal: replacement,
      afterDelivery: replacement
    })
  }

  it('preserves deliberately retyped same text after Back/unmount and same-scope remount', async () => {
    await scenario('remount-same-text', true, 'ping')
  })

  it('restores a definitely rejected send after newer typing on a remounted screen', async () => {
    const delivery = deferred<'rejected'>()
    transport.heal.mockResolvedValue(true)
    transport.clearInput.mockResolvedValue(true)
    transport.send.mockImplementation(() => delivery.promise)
    await mount('rejected')
    await edit('ping')
    let sending: Promise<boolean> | undefined
    await act(async () => {
      sending = current().sender.send('ping')
    })
    expect(current().drafts.composerText).toBe('')
    await remount('rejected')
    await edit('new draft')

    await act(async () => {
      delivery.resolve('rejected')
      expect(await sending).toBe(false)
    })
    expect(current().drafts.composerText).toBe('new draft\n\nping')
    expect(transport.error).toHaveBeenCalledTimes(1)
  })

  it('keeps an unknown command at its original destination beside later edits without replay', async () => {
    const delivery = deferred<'unknown'>()
    transport.heal.mockResolvedValue(true)
    transport.clearInput.mockResolvedValue(true)
    transport.send.mockImplementation(() => delivery.promise)
    await mount('unknown-command')
    const command = '/clear  \n'
    await edit(command)
    let sending: Promise<unknown> | undefined
    await act(async () => {
      sending = current().sender.sendWithOutcome(command)
    })
    expect(current().drafts.composerText).toBe('')
    await edit('/compact')
    await remount('different-tab')
    await edit('other tab draft')
    await act(async () => {
      delivery.resolve('unknown')
      expect(await sending).toBe('unknown')
    })
    expect(current().drafts.composerText).toBe('other tab draft')
    await remount('unknown-command')
    expect(current().drafts.composerText).toBe(`/compact\n\n${command}`)
    expect(current().drafts.pending).toEqual([])
    expect(transport.send).toHaveBeenCalledTimes(1)
    expect(transport.error).toHaveBeenCalledWith(
      'Delivery unconfirmed — check chat before retrying'
    )
  })

  async function sendLost(text: string) {
    await edit(text)
    await act(async () => {
      expect(await current().sender.sendWithOutcome(text)).toBe('unknown')
    })
    expect(current().drafts.composerText).toBe('')
  }

  it('hands back only the lost-ack sends the transcript never showed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    transport.heal.mockResolvedValue(true)
    transport.clearInput.mockResolvedValue(true)
    transport.send.mockResolvedValue('unknown')
    await mount('lost-ack')
    await sendLost('landed message')
    await sendLost('lost message\n')
    transcript = [
      {
        id: 'u1',
        role: 'user',
        blocks: [{ type: 'text', text: 'landed message' }],
        timestamp: 1,
        source: 'transcript'
      }
    ]
    await act(async () => rerender())
    await edit('typed meanwhile')
    await act(async () => {
      vi.advanceTimersByTime(20_000)
    })
    expect(current().drafts.composerText).toBe('typed meanwhile\n\nlost message\n')
    expect(transport.error).toHaveBeenCalledTimes(1)
    expect(transport.error).toHaveBeenCalledWith('Not confirmed. Restored to the box.')
    expect(transport.send).toHaveBeenCalledTimes(2)
  })

  it('leaves a lost-ack send made mid-turn out of the composer, since the agent may hold it queued', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    transport.heal.mockResolvedValue(true)
    transport.clearInput.mockResolvedValue(true)
    transport.send.mockResolvedValue('unknown')
    await mount('mid-turn', 7)
    await sendLost('follow-up')
    await act(async () => {
      vi.advanceTimersByTime(20_000)
    })
    expect(current().drafts.composerText).toBe('')
    expect(transport.error).toHaveBeenCalledWith(
      'Delivery unconfirmed — check chat before retrying'
    )
  })
})
