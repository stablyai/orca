import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import {
  useMobileNativeChatSession,
  type MobileNativeChatSession
} from './use-mobile-native-chat-session'

function message(id: string): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text: id }],
    timestamp: 1,
    source: 'transcript'
  }
}

let renderer: ReactTestRenderer | undefined

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = undefined
})

async function mount() {
  let state: MobileNativeChatSession | undefined
  let emit: (frame: unknown) => void = () => {}
  let resolvePage: (response: RpcResponse) => void = () => {}
  const subscribe = vi.fn<RpcClient['subscribe']>((_method, _params, listener) => {
    emit = listener
    return () => {}
  })
  const client: RpcClient = {
    subscribe,
    sendRequest: () => new Promise<RpcResponse>((resolve) => (resolvePage = resolve)),
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }
  function Harness() {
    state = useMobileNativeChatSession({
      client,
      sourceIdentity: 'host-a\0workspace-a',
      agent: 'opencode2',
      sessionId: 'same-session',
      transcriptPath: null
    })
    return null
  }
  await act(async () => {
    renderer = create(createElement(Harness))
  })
  const current = () => {
    if (!state) {
      throw new Error('Transcript hook did not mount')
    }
    return state
  }
  const frame = async (value: unknown) => {
    await act(async () => emit(value))
  }
  const startPage = () => act(() => current().loadEarlier())
  const finishPage = async (result: unknown) => {
    await act(async () => resolvePage({ id: 'page', ok: true, result }))
  }
  await frame({
    type: 'snapshot',
    messages: [message('retained')],
    hasMore: true,
    beforeOffset: 100
  })
  await frame({ type: 'error', message: 'Temporary transcript read failure' })
  expect(current().error).toBe('Temporary transcript read failure')
  return {
    current,
    frame,
    subscribe,
    startPage,
    finishPage,
    page: async (result: unknown) => {
      startPage()
      await finishPage(result)
    }
  }
}

describe('same-session mobile transcript recovery', () => {
  it.each(['snapshot', 'replacement', 'appended'])(
    'clears the earlier error on a readable %s without resubscribing',
    async (type) => {
      const harness = await mount()
      await harness.frame({ type, messages: [message('recovered')] })

      expect(harness.current().error).toBeUndefined()
      expect(harness.current().status).toBe('ready')
      expect(harness.current().messages.some((entry) => entry.id === 'recovered')).toBe(true)
      expect(harness.subscribe).toHaveBeenCalledTimes(1)
    }
  )

  it('keeps the error through pending and unreadable frames until a real snapshot arrives', async () => {
    const harness = await mount()
    await harness.frame({ type: 'snapshot', messages: [], pending: true })
    await harness.frame({ type: 'snapshot' })
    await harness.frame({ type: 'keepalive' })

    expect(harness.current().error).toBe('Temporary transcript read failure')
    expect(harness.current().status).toBe('awaiting-transcript')
    await harness.frame({ type: 'snapshot', messages: [message('recovered')] })
    expect(harness.current().error).toBeUndefined()
    expect(harness.current().status).toBe('ready')
  })

  it('clears the error and restores ready after a readable older page', async () => {
    const harness = await mount()
    await harness.page({ messages: [message('older')], hasMore: false, beforeOffset: 0 })

    expect(harness.current().error).toBeUndefined()
    expect(harness.current().status).toBe('ready')
    expect(harness.current().messages.map((entry) => entry.id)).toEqual(['older', 'retained'])
  })

  it.each([
    null,
    {},
    { messages: null },
    { messages: [], pending: true },
    { error: 'Still locked' }
  ])('keeps the error for an unreadable or pending page: %j', async (result) => {
    const harness = await mount()
    await harness.page(result)

    expect(harness.current().error).toBe('Temporary transcript read failure')
    expect(harness.current().status).toBe('error')
    expect(harness.current().messages.map((entry) => entry.id)).toEqual(['retained'])
  })

  it('does not clear a newer error with a page from before the authoritative replacement', async () => {
    const harness = await mount()
    harness.startPage()
    await harness.frame({ type: 'replacement', messages: [message('new-window')] })
    await harness.frame({ type: 'error', message: 'Newer failure' })
    await harness.finishPage({ messages: [message('stale')], beforeOffset: 0 })

    expect(harness.current().error).toBe('Newer failure')
    expect(harness.current().messages.map((entry) => entry.id)).toEqual(['new-window'])
  })

  it.each([
    ['error', 'Newer failure'],
    ['end', 'Transcript stream ended']
  ])('invalidates a page started before a stream %s', async (type, error) => {
    const harness = await mount()
    await harness.frame({ type: 'appended', messages: [message('live')] })
    harness.startPage()
    await harness.frame({ type, message: error })

    expect(harness.current().loadingEarlier).toBe(false)
    await harness.finishPage({ messages: [message('stale')], beforeOffset: 0 })
    expect(harness.current().error).toBe(error)
    expect(harness.current().status).toBe('error')
    expect(harness.current().messages.map((entry) => entry.id)).toEqual(['retained', 'live'])

    await harness.page({ messages: [message('older')], hasMore: false, beforeOffset: 0 })
    expect(harness.current().error).toBeUndefined()
    expect(harness.current().status).toBe('ready')
    expect(harness.current().messages.map((entry) => entry.id)).toEqual([
      'older',
      'retained',
      'live'
    ])
    expect(harness.subscribe).toHaveBeenCalledTimes(1)
  })
})
