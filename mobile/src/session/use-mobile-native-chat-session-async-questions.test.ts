import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import type { RpcClient } from '../transport/rpc-client'
import {
  useMobileNativeChatSession,
  type MobileNativeChatSession
} from './use-mobile-native-chat-session'

const message = (id: string): NativeChatMessage => ({
  id,
  role: 'assistant',
  blocks: [{ type: 'text', text: id }],
  timestamp: 1,
  source: 'transcript'
})
const ready = (title: string) => ({
  state: 'ready' as const,
  questions: [{ key: title, index: 0, title }]
})

describe('useMobileNativeChatSession async questions', () => {
  let renderer: ReactTestRenderer | null = null
  let state: MobileNativeChatSession | null = null
  let emit: (frame: unknown) => void = () => {}

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    state = null
  })

  function Harness({ client, sessionId }: { client: RpcClient; sessionId: string }): null {
    state = useMobileNativeChatSession({
      client,
      sourceIdentity: 'host\0workspace',
      agent: 'codex',
      sessionId,
      transcriptPath: null
    })
    return null
  }

  function client(): RpcClient {
    return {
      sendRequest: vi.fn(),
      subscribe: (_method, _params, onData) => {
        emit = onData
        return () => {}
      },
      updateTerminalSubscriptionViewport: () => {},
      getState: () => 'connected',
      getReconnectAttempt: () => 0,
      getLastConnectedAt: () => 1,
      onStateChange: () => () => {},
      notifyForeground: () => {},
      close: () => {}
    }
  }

  it('takes the host set from the snapshot, whatever page of history is loaded', async () => {
    const rpc = client()
    await act(async () => {
      renderer = create(createElement(Harness, { client: rpc, sessionId: 's1' }))
    })
    expect(state?.asyncQuestions).toEqual({ state: 'absent' })
    await act(async () => {
      emit({
        type: 'snapshot',
        messages: [message('latest')],
        hasMore: true,
        asyncQuestions: { state: 'pending' }
      })
    })
    expect(state?.asyncQuestions).toEqual({ state: 'pending' })
    await act(async () => {
      emit({ type: 'appended', messages: [], asyncQuestions: ready('Old?') })
    })
    expect(state?.asyncQuestions).toEqual(ready('Old?'))
    await act(async () => {
      emit({ type: 'appended', messages: [message('more')] })
    })
    expect(state?.asyncQuestions).toEqual(ready('Old?'))
  })

  it('keeps the shown questions through a resubscribe until the host re-derives them', async () => {
    const rpc = client()
    await act(async () => {
      renderer = create(createElement(Harness, { client: rpc, sessionId: 's1' }))
    })
    await act(async () => {
      emit({ type: 'snapshot', messages: [], hasMore: false, asyncQuestions: ready('Keep?') })
    })
    // A reconnect resubscribes: its snapshot is pending while the host re-derives.
    await act(async () => {
      emit({ type: 'snapshot', messages: [], hasMore: false, asyncQuestions: { state: 'pending' } })
    })
    expect(state?.asyncQuestions).toEqual(ready('Keep?'))
    await act(async () => {
      emit({ type: 'appended', messages: [], asyncQuestions: ready('Next?') })
    })
    expect(state?.asyncQuestions).toEqual(ready('Next?'))
  })

  it('reads a host that publishes nothing as absent, and never carries a set to another chat', async () => {
    const rpc = client()
    await act(async () => {
      renderer = create(createElement(Harness, { client: rpc, sessionId: 's1' }))
    })
    await act(async () => {
      emit({ type: 'snapshot', messages: [], hasMore: false, asyncQuestions: ready('A?') })
    })
    await act(async () => {
      renderer?.update(createElement(Harness, { client: rpc, sessionId: 's2' }))
    })
    expect(state?.asyncQuestions).toEqual({ state: 'absent' })
    await act(async () => {
      emit({ type: 'snapshot', messages: [], hasMore: false })
    })
    expect(state?.asyncQuestions).toEqual({ state: 'absent' })
  })
})
