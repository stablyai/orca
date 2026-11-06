import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../../transport/rpc-client'
import { useMobileTerminalChatQueue } from './use-mobile-terminal-chat-queue'
import {
  NativeChatTerminalQueueRequest,
  type NativeChatTerminalQueueSnapshot
} from '../../../../src/shared/native-chat/native-chat-terminal-queue'
import { NATIVE_CHAT_TERMINAL_QUEUE_CAPABILITY } from '../../../../src/shared/native-chat/native-chat-terminal-queue-capability'
import { UNCONFIRMED_SEND_MESSAGE } from './use-mobile-native-chat-unconfirmed-sends'

describe('mobile Hermes terminal queue', () => {
  let renderer: ReactTestRenderer | null = null
  afterEach(() => {
    act(() => renderer?.unmount())
    vi.useRealTimers()
  })

  it('accepts multiple busy sends, reuses queue cards and refreshes idle after reconnect', async () => {
    vi.useFakeTimers()
    let api: ReturnType<typeof useMobileTerminalChatQueue> | undefined
    let revision = 0
    const snapshot: NativeChatTerminalQueueSnapshot = {
      revision: '0',
      activity: { state: 'working', workingSequence: 1 },
      queuedMessages: []
    }
    const sendRequest = vi.fn<RpcClient['sendRequest']>(async (method, params) => {
      expect(method).toBe('nativeChat.terminalQueue')
      const { action } = NativeChatTerminalQueueRequest.parse(params)
      if (action.type === 'enqueue') {
        snapshot.queuedMessages = [
          ...snapshot.queuedMessages,
          {
            messageId: action.messageId,
            position: ++revision,
            state: 'waiting',
            body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: action.text }] }
          }
        ]
        snapshot.revision = String(revision)
      }
      if (action.type === 'delete') {
        snapshot.queuedMessages = snapshot.queuedMessages.filter(
          (card) => !action.messageIds.includes(card.messageId)
        )
        snapshot.revision = String(++revision)
      }
      if (action.type === 'edit') {
        snapshot.queuedMessages = snapshot.queuedMessages.map((card) =>
          card.messageId === action.messageId ? { ...card, paused: true } : card
        )
        snapshot.revision = String(++revision)
      }
      return { id: 'q', ok: true, result: structuredClone(snapshot), _meta: { runtimeId: 'r' } }
    })
    const client: RpcClient = {
      sendRequest,
      subscribe: () => () => {},
      updateTerminalSubscriptionViewport: () => {},
      getState: () => 'connected',
      getReconnectAttempt: () => 0,
      getLastConnectedAt: () => 1,
      onStateChange: () => () => {},
      notifyForeground: () => {},
      close: () => {}
    }
    const appendText = vi.fn(() => true)
    function Harness({ enabled = true }: { enabled?: boolean }) {
      api = useMobileTerminalChatQueue({
        client,
        terminal: 'term',
        enabled,
        hostCapabilities: [NATIVE_CHAT_TERMINAL_QUEUE_CAPABILITY],
        appendText
      })
      return null
    }
    await act(async () => {
      renderer = create(createElement(Harness))
    })
    await act(async () => {
      expect(await api?.enqueue('First')).toBe('queued')
      expect(await api?.enqueue('Second')).toBe('queued')
    })
    expect(api?.controls.cards.map((card) => card.text)).toEqual(['First', 'Second'])
    expect(api?.controls.cards.every((card) => card.waitsForAgent)).toBe(true)
    expect(api?.sendFollowUp?.action).toBe('queue')
    const firstId = api?.controls.cards[0]?.messageId
    expect(firstId).toBeDefined()
    await act(async () => {
      await api?.controls.edit?.(firstId!)
    })
    expect(appendText).toHaveBeenCalledWith('First')
    expect(api?.controls.cards.map((card) => card.text)).toEqual(['Second'])
    await act(async () => {
      renderer?.update(createElement(Harness, { enabled: false }))
    })
    snapshot.activity = { state: 'idle', workingSequence: 2 }
    snapshot.queuedMessages = []
    snapshot.revision = String(++revision)
    await act(async () => {
      renderer?.update(createElement(Harness))
    })
    expect(api?.activity?.state).toBe('idle')
    expect(api?.sendFollowUp).toBeNull()
    expect(api?.controls.cards).toEqual([])
  })

  it('reports a host refusal instead of leaving a silent rejected enqueue', async () => {
    const onSendError = vi.fn()
    let api: ReturnType<typeof useMobileTerminalChatQueue> | undefined
    const client: RpcClient = {
      sendRequest: async () => ({
        id: 'q',
        ok: false,
        error: { code: 'internal', message: 'terminal_chat_queue_full' },
        _meta: { runtimeId: 'r' }
      }),
      subscribe: () => () => {},
      updateTerminalSubscriptionViewport: () => {},
      getState: () => 'connected',
      getReconnectAttempt: () => 0,
      getLastConnectedAt: () => 1,
      onStateChange: () => () => {},
      notifyForeground: () => {},
      close: () => {}
    }
    function Harness() {
      api = useMobileTerminalChatQueue({
        client,
        terminal: 'term',
        enabled: true,
        hostCapabilities: [NATIVE_CHAT_TERMINAL_QUEUE_CAPABILITY],
        appendText: () => true,
        onSendError
      })
      return null
    }
    await act(async () => {
      renderer = create(createElement(Harness))
    })
    await act(async () => {
      expect(await api?.enqueue('Later')).toBe('rejected')
    })
    expect(onSendError).toHaveBeenCalledTimes(1)
    expect(onSendError).toHaveBeenCalledWith('Message not sent')
  })

  it('drops a held busy snapshot when the queue is disabled', async () => {
    const reads: Array<
      (value: {
        id: string
        ok: true
        result: NativeChatTerminalQueueSnapshot
        _meta: { runtimeId: string }
      }) => void
    > = []
    const working: NativeChatTerminalQueueSnapshot = {
      revision: '1',
      activity: { state: 'working', workingSequence: 1 },
      queuedMessages: [
        {
          messageId: '11111111-1111-4111-8111-111111111111',
          position: 1,
          state: 'waiting',
          body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Held' }] }
        }
      ]
    }
    const client: RpcClient = {
      sendRequest: async (_method, params) => {
        const { action } = NativeChatTerminalQueueRequest.parse(params)
        if (action.type !== 'read') {
          return {
            id: 'q',
            ok: false,
            error: { code: 'internal', message: 'unexpected' },
            _meta: { runtimeId: 'r' }
          }
        }
        return new Promise((resolve) => {
          reads.push(resolve)
        })
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
    let api: ReturnType<typeof useMobileTerminalChatQueue> | undefined
    function Harness({ enabled = true }: { enabled?: boolean }) {
      api = useMobileTerminalChatQueue({
        client,
        terminal: 'term',
        enabled,
        hostCapabilities: [NATIVE_CHAT_TERMINAL_QUEUE_CAPABILITY],
        appendText: () => true
      })
      return null
    }
    await act(async () => {
      renderer = create(createElement(Harness))
    })
    await act(async () => {
      reads.shift()?.({
        id: 'q',
        ok: true,
        result: working,
        _meta: { runtimeId: 'r' }
      })
    })
    expect(api?.activity?.state).toBe('working')
    expect(api?.controls.cards).toHaveLength(1)
    await act(async () => {
      renderer?.update(createElement(Harness, { enabled: false }))
    })
    expect(api?.activity).toBeUndefined()
    expect(api?.controls.cards).toEqual([])
    await act(async () => {
      renderer?.update(createElement(Harness))
    })
    expect(api?.activity).toBeUndefined()
    expect(api?.controls.cards).toEqual([])
    await act(async () => {
      reads.shift()?.({
        id: 'q',
        ok: true,
        result: {
          revision: '2',
          activity: { state: 'idle', workingSequence: 2 },
          queuedMessages: []
        },
        _meta: { runtimeId: 'r' }
      })
    })
    expect(api?.activity?.state).toBe('idle')
  })

  it('ignores a read from the previous enabled period after reconnect', async () => {
    const reads: Array<
      (value: {
        id: string
        ok: true
        result: NativeChatTerminalQueueSnapshot
        _meta: { runtimeId: string }
      }) => void
    > = []
    const client: RpcClient = {
      sendRequest: async (_method, params) => {
        const { action } = NativeChatTerminalQueueRequest.parse(params)
        if (action.type !== 'read') {
          return {
            id: 'q',
            ok: false,
            error: { code: 'internal', message: 'unexpected' },
            _meta: { runtimeId: 'r' }
          }
        }
        return new Promise((resolve) => {
          reads.push(resolve)
        })
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
    let api: ReturnType<typeof useMobileTerminalChatQueue> | undefined
    function Harness({ enabled = true }: { enabled?: boolean }) {
      api = useMobileTerminalChatQueue({
        client,
        terminal: 'term',
        enabled,
        hostCapabilities: [NATIVE_CHAT_TERMINAL_QUEUE_CAPABILITY],
        appendText: () => true
      })
      return null
    }
    await act(async () => {
      renderer = create(createElement(Harness))
    })
    expect(reads).toHaveLength(1)
    await act(async () => {
      renderer?.update(createElement(Harness, { enabled: false }))
    })
    await act(async () => {
      renderer?.update(createElement(Harness))
    })
    await act(async () => {
      reads.shift()?.({
        id: 'q',
        ok: true,
        result: {
          revision: '1',
          activity: { state: 'working', workingSequence: 1 },
          queuedMessages: [
            {
              messageId: '11111111-1111-4111-8111-111111111111',
              position: 1,
              state: 'waiting',
              body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Stale' }] }
            }
          ]
        },
        _meta: { runtimeId: 'r' }
      })
    })
    expect(api?.activity).toBeUndefined()
    expect(api?.controls.cards).toEqual([])
    await act(async () => {
      await vi.waitFor(() => {
        expect(reads.length).toBeGreaterThan(0)
      })
      reads.shift()?.({
        id: 'q',
        ok: true,
        result: {
          revision: '2',
          activity: { state: 'idle', workingSequence: 2 },
          queuedMessages: []
        },
        _meta: { runtimeId: 'r' }
      })
    })
    expect(api?.activity?.state).toBe('idle')
  })

  it('reports an accepted enqueue as unknown when the queue period ends first', async () => {
    const reads: Array<
      (value: {
        id: string
        ok: true
        result: NativeChatTerminalQueueSnapshot
        _meta: { runtimeId: string }
      }) => void
    > = []
    const idle: NativeChatTerminalQueueSnapshot = {
      revision: '1',
      activity: { state: 'idle', workingSequence: 1 },
      queuedMessages: []
    }
    const client: RpcClient = {
      sendRequest: async (_method, params) => {
        NativeChatTerminalQueueRequest.parse(params)
        return new Promise((resolve) => {
          reads.push(resolve)
        })
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
    let api: ReturnType<typeof useMobileTerminalChatQueue> | undefined
    function Harness({ enabled = true }: { enabled?: boolean }) {
      api = useMobileTerminalChatQueue({
        client,
        terminal: 'term',
        enabled,
        hostCapabilities: [NATIVE_CHAT_TERMINAL_QUEUE_CAPABILITY],
        appendText: () => true,
        onSendError
      })
      return null
    }
    await act(async () => {
      renderer = create(createElement(Harness))
    })
    await act(async () => {
      reads.shift()?.({ id: 'q', ok: true, result: idle, _meta: { runtimeId: 'r' } })
    })
    let pending: Promise<string> | undefined
    await act(async () => {
      pending = api?.enqueue('Later')
      await vi.waitFor(() => {
        expect(reads.length).toBeGreaterThan(0)
      })
    })
    await act(async () => {
      renderer?.update(createElement(Harness, { enabled: false }))
    })
    await act(async () => {
      reads.shift()?.({ id: 'q', ok: true, result: idle, _meta: { runtimeId: 'r' } })
      await expect(pending).resolves.toBe('unknown')
    })
    expect(onSendError).toHaveBeenCalledWith(UNCONFIRMED_SEND_MESSAGE)
  })
})
