import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import {
  resetMobileNativeChatStopLeasesForTests,
  requestMobileNativeChatWriteLease
} from './mobile-native-chat-stop-lease'
import { resetMobileNativeChatStopCleanupForTests } from './mobile-native-chat-stop-cleanup'

const answerAskWrite = vi.fn(async () => true)
const cancelPendingAnswer = vi.fn()
const cancelAskWrite = vi.fn(async () => true)
const permissionWrite = vi.fn(async () => true)
const messageWrite = vi.fn(async () => true)
const messageWriteWithOutcome = vi.fn(async () => 'accepted' as const)
const questionAnswerWrite = vi.fn(async () => true)

vi.mock('./use-mobile-session-view-mode', () => ({
  useMobileSessionViewMode: () => ({ isTabChatView: () => true, toggleTabChatView: vi.fn() })
}))
vi.mock('./use-mobile-native-chat-session', () => ({
  useMobileNativeChatSession: () => ({ messages: [], status: 'ready', transcriptLoading: false })
}))
vi.mock('./use-mobile-native-chat-drafts', () => ({
  useMobileNativeChatDrafts: () => ({
    composerText: '',
    setComposerText: vi.fn(),
    pending: [],
    captureSendOrigin: vi.fn(),
    readSeededLaunchDraft: () => null,
    readSeededLaunchDraftSeed: () => null,
    clearDraftForSend: vi.fn(),
    restoreRejectedDraft: vi.fn(),
    acceptSend: vi.fn(),
    holdUnconfirmedSend: vi.fn()
  })
}))
vi.mock('./use-mobile-native-chat-prompts', () => ({
  useMobileNativeChatPrompts: () => ({ permission: null, question: null, ask: null })
}))
vi.mock('./use-mobile-native-chat-answer-send', () => ({
  useMobileNativeChatAnswerSend: () => ({
    answerAsk: answerAskWrite,
    cancelPending: cancelPendingAnswer
  })
}))
vi.mock('./use-mobile-native-chat-cancel-ask', () => ({
  useMobileNativeChatCancelAsk: () => cancelAskWrite
}))
vi.mock('./mobile-native-chat-permission-send', () => ({
  useMobileNativeChatPermissionSend: () => permissionWrite
}))
vi.mock('./use-mobile-native-chat-message-send', () => ({
  useMobileNativeChatMessageSend: () => ({
    send: messageWrite,
    sendWithOutcome: messageWriteWithOutcome,
    answerQuestion: questionAnswerWrite
  })
}))
vi.mock('./use-mobile-native-chat-file-search', () => ({
  useMobileNativeChatFileSearch: () => ({ nativeChatFilePaths: [], loadNativeChatFiles: vi.fn() })
}))

import {
  useMobileNativeChatController,
  type MobileNativeChatController
} from './use-mobile-native-chat-controller'

const acceptedResponse = {
  id: 'send',
  ok: true as const,
  result: { send: { accepted: true } },
  _meta: { runtimeId: 'runtime-1' }
}

describe('useMobileNativeChatController Stop interleaving', () => {
  let renderer: ReactTestRenderer | null = null
  let controller: MobileNativeChatController | null = null
  let resolveCleanup!: (response: unknown) => void
  let cleanupPromise!: Promise<unknown>
  const handleRef = { current: 'terminal-1' as string | null }
  const sendRequest = vi.fn()
  const onSendError = vi.fn()

  function Harness({ sessionId }: { sessionId: string }): null {
    controller = useMobileNativeChatController({
      client: { sendRequest } as unknown as RpcClient,
      connState: 'connected',
      hostId: 'host-1',
      worktreeId: 'worktree-1',
      activeSessionTab: {
        type: 'terminal',
        launchAgent: 'codex',
        agentStatus: {
          state: 'working',
          agentType: 'codex',
          providerSession: { id: sessionId }
        }
      } as never,
      activeSessionTabId: 'tab-1',
      activeHandleRef: handleRef,
      deviceTokenRef: { current: 'mobile-1' },
      nativeChatTranscriptIsLocalReadable: true,
      nativeChatInputLeaseReady: true,
      onSendError,
      onSendResolved: vi.fn()
    })
    return null
  }

  async function render(sessionId: string): Promise<void> {
    await act(async () => {
      const element = createElement(Harness, { sessionId })
      if (renderer) {
        renderer.update(element)
      } else {
        renderer = create(element)
      }
    })
  }

  async function startStop(): Promise<void> {
    act(() => controller?.handleNativeChatStop())
    await act(async () => vi.advanceTimersByTimeAsync(160))
    expect(sendRequest.mock.calls.at(-1)?.[1]).toMatchObject({ text: '/stop', enter: true })
  }

  async function settleCleanup(accepted = true): Promise<void> {
    await act(async () => {
      resolveCleanup({
        ...acceptedResponse,
        result: { send: { accepted } }
      })
      await Promise.resolve()
    })
  }

  beforeEach(async () => {
    vi.useFakeTimers()
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    resetMobileNativeChatStopLeasesForTests()
    resetMobileNativeChatStopCleanupForTests()
    handleRef.current = 'terminal-1'
    cleanupPromise = new Promise((resolve) => {
      resolveCleanup = resolve
    })
    sendRequest.mockImplementation((_method: string, params: { text?: string }) =>
      params.text === '/stop' ? cleanupPromise : Promise.resolve(acceptedResponse)
    )
    const original = console.error
    const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) {
        return
      }
      original(...args)
    })
    try {
      await render('session-1')
    } finally {
      spy.mockRestore()
    }
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    controller = null
    resetMobileNativeChatStopLeasesForTests()
    resetMobileNativeChatStopCleanupForTests()
    vi.useRealTimers()
  })

  it('queues every controller writer and ignores duplicate Stop taps until cleanup settles', async () => {
    await startStop()
    const sends = [
      controller!.handleNativeChatSend('message'),
      controller!.handleNativeChatSendWithOutcome('image body', ['file:///image.jpg']),
      controller!.handleNativeChatAnswerAsk({} as never, []),
      controller!.handleNativeChatCancelAsk(),
      controller!.handleNativeChatRespondPermission('1'),
      controller!.handleNativeChatQuestionAnswer('answer')
    ]
    const imageWrite = vi.fn()
    const imageBarrier = controller!.runNativeChatWrite(async () => {
      imageWrite()
      return true
    }, false)
    act(() => {
      controller?.handleNativeChatStop()
      controller?.handleNativeChatStop()
    })
    await Promise.resolve()

    expect(answerAskWrite).not.toHaveBeenCalled()
    expect(cancelAskWrite).not.toHaveBeenCalled()
    expect(permissionWrite).not.toHaveBeenCalled()
    expect(messageWrite).not.toHaveBeenCalled()
    expect(messageWriteWithOutcome).not.toHaveBeenCalled()
    expect(questionAnswerWrite).not.toHaveBeenCalled()
    expect(imageWrite).not.toHaveBeenCalled()
    expect(cancelPendingAnswer).toHaveBeenCalledOnce()
    expect(sendRequest.mock.calls.filter(([, params]) => params.text === '/stop')).toHaveLength(1)

    await settleCleanup()
    await Promise.all([...sends, imageBarrier])
    expect(answerAskWrite).toHaveBeenCalledOnce()
    expect(cancelAskWrite).toHaveBeenCalledOnce()
    expect(permissionWrite).toHaveBeenCalledOnce()
    expect(messageWrite).toHaveBeenCalledOnce()
    expect(messageWriteWithOutcome).toHaveBeenCalledOnce()
    expect(questionAnswerWrite).toHaveBeenCalledOnce()
    expect(imageWrite).toHaveBeenCalledOnce()
  })

  it('runs Stop after an admitted host send settles and before an earlier queued writer', async () => {
    let finishHostSend!: (accepted: boolean) => void
    messageWrite.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finishHostSend = resolve
        })
    )
    const activeSend = controller!.handleNativeChatSend('host text and Enter')
    await Promise.resolve()
    expect(messageWrite).toHaveBeenCalledOnce()

    const queuedPermission = controller!.handleNativeChatRespondPermission('1')
    act(() => controller!.handleNativeChatStop())
    await Promise.resolve()
    expect(sendRequest).not.toHaveBeenCalled()
    expect(permissionWrite).not.toHaveBeenCalled()

    finishHostSend(true)
    await activeSend
    await act(async () => vi.advanceTimersByTimeAsync(160))
    expect(sendRequest.mock.calls.at(-1)?.[1]).toMatchObject({ text: '/stop', enter: true })
    expect(permissionWrite).not.toHaveBeenCalled()

    await settleCleanup()
    await expect(queuedPermission).resolves.toBe(true)
    expect(permissionWrite).toHaveBeenCalledWith('1')
  })

  it('holds Stop behind every leg of an admitted card action', async () => {
    let finishCard!: (accepted: boolean) => void
    const legs: string[] = []
    answerAskWrite.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          legs.push('first')
          finishCard = (accepted) => {
            legs.push('last')
            resolve(accepted)
          }
        })
    )
    const card = controller!.handleNativeChatAnswerAsk({} as never, [])
    await Promise.resolve()
    act(() => controller!.handleNativeChatStop())
    await Promise.resolve()
    expect(sendRequest).not.toHaveBeenCalled()
    expect(legs).toEqual(['first'])

    finishCard(true)
    await card
    await act(async () => vi.advanceTimersByTimeAsync(160))
    expect(legs).toEqual(['first', 'last'])
    expect(sendRequest.mock.calls.at(-1)?.[1]).toMatchObject({ text: '/stop' })
    await settleCleanup()
  })

  it('replays queued writers one at a time in call order', async () => {
    let finishMessage!: (accepted: boolean) => void
    let finishPermission!: (accepted: boolean) => void
    const order: string[] = []
    messageWrite.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          order.push('message')
          finishMessage = resolve
        })
    )
    permissionWrite.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          order.push('permission')
          finishPermission = resolve
        })
    )
    questionAnswerWrite.mockImplementationOnce(async () => {
      order.push('question')
      return true
    })

    const message = controller!.handleNativeChatSend('one')
    const permission = controller!.handleNativeChatRespondPermission('2')
    const question = controller!.handleNativeChatQuestionAnswer('three')
    await Promise.resolve()
    expect(order).toEqual(['message'])

    finishMessage(true)
    await message
    await Promise.resolve()
    expect(order).toEqual(['message', 'permission'])

    finishPermission(true)
    await permission
    await question
    expect(order).toEqual(['message', 'permission', 'question'])
  })

  it('releases ownership after an admitted writer rejects', async () => {
    messageWrite.mockRejectedValueOnce(new Error('send failed'))
    const failed = controller!.handleNativeChatSend('first')
    const successor = controller!.handleNativeChatRespondPermission('1')

    await expect(failed).rejects.toThrow('send failed')
    await expect(successor).resolves.toBe(true)
    expect(permissionWrite).toHaveBeenCalledOnce()
  })

  it('holds an admitted action through unmount and releases when it settles', async () => {
    let finishMessage!: (accepted: boolean) => void
    messageWrite.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finishMessage = resolve
        })
    )
    const active = controller!.handleNativeChatSend('in flight')
    await Promise.resolve()

    act(() => renderer?.unmount())
    renderer = null
    const successor = requestMobileNativeChatWriteLease('terminal-1')
    const acquired = vi.fn()
    void successor.acquired.then(acquired)
    await Promise.resolve()
    expect(acquired).not.toHaveBeenCalled()

    finishMessage(true)
    await active
    const lease = await successor.acquired
    expect(acquired).toHaveBeenCalledOnce()
    lease?.release()
  })

  it('drops a queued stale-session write while allowing the replacement route', async () => {
    await startStop()
    const previousController = controller!
    const staleSend = previousController.handleNativeChatSend('stale')

    await render('session-2')
    const currentSend = controller!.handleNativeChatSend('current')
    await settleCleanup()

    await expect(staleSend).resolves.toBe(false)
    await expect(currentSend).resolves.toBe(true)
    expect(messageWrite).toHaveBeenCalledOnce()
    expect(messageWrite).toHaveBeenCalledWith('current', undefined)
  })

  it('credits Stop waiting back to a queued image send budget', async () => {
    await startStop()
    const deadline = Date.now() + 10_000
    const queuedSend = controller!.handleNativeChatSendWithOutcome(
      'image body',
      ['file:///image.jpg'],
      deadline
    )

    await act(async () => vi.advanceTimersByTimeAsync(4_000))
    await settleCleanup()

    await expect(queuedSend).resolves.toBe('accepted')
    expect(messageWriteWithOutcome).toHaveBeenCalledWith(
      'image body',
      ['file:///image.jpg'],
      deadline + 4_000
    )
  })

  it('drops queued writes on unmount and releases the terminal lease', async () => {
    await startStop()
    const queuedSend = controller!.handleNativeChatSend('stale')
    const released = requestMobileNativeChatWriteLease('terminal-1').acquired.then((lease) => {
      lease?.release()
    })

    act(() => renderer?.unmount())
    renderer = null
    await settleCleanup()

    await expect(queuedSend).resolves.toBe(false)
    await expect(released).resolves.toBeUndefined()
    expect(messageWrite).not.toHaveBeenCalled()
  })

  it('releases a queued writer after rejected background cleanup', async () => {
    await startStop()
    const queuedSend = controller!.handleNativeChatSend('after failure')

    await settleCleanup(false)

    await expect(queuedSend).resolves.toBe(true)
    expect(messageWrite).toHaveBeenCalledWith('after failure', undefined)
    expect(onSendError).toHaveBeenCalledWith(
      'Agent interrupted; background cleanup pending — reconnect or return to this chat to retry'
    )
  })
})
