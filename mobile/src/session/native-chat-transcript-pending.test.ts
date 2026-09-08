import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { nativeHostSessionNativeChatOperations } from './native-host-session-native-chat-operations'
import {
  useMobileNativeChatSession,
  type MobileNativeChatSession
} from './use-mobile-native-chat-session'

describe('native chat before the first transcript flush', () => {
  it('negotiates pending snapshots and waits for the authoritative transcript', async () => {
    let state: MobileNativeChatSession | null = null
    let emit: (frame: unknown) => void = () => {}
    const subscribe: RpcClient['subscribe'] = vi.fn((_method, params, onData) => {
      emit = onData
      if (
        (params as { capabilities?: { transcriptPending?: number } }).capabilities
          ?.transcriptPending === 1
      ) {
        onData({ type: 'snapshot', messages: [], hasMore: false, pending: true })
      }
      return () => {}
    })
    const operations = nativeHostSessionNativeChatOperations({ subscribe } as unknown as RpcClient)
    function Harness() {
      state = useMobileNativeChatSession({
        operations,
        workspaceId: 'workspace',
        agent: 'claude',
        sessionId: 'session',
        transcriptPath: null,
        terminalId: 'terminal',
        clientId: 'device'
      })
      return null
    }
    let renderer: ReturnType<typeof create> | undefined
    try {
      await act(async () => {
        renderer = create(createElement(Harness))
      })
      expect(state).toMatchObject({
        status: 'awaiting-transcript',
        transcriptLoading: true,
        messages: []
      })
      await act(async () => emit({ type: 'snapshot', messages: [], hasMore: false }))
      expect(state).toMatchObject({ status: 'ready', transcriptLoading: false, messages: [] })
      expect(subscribe).toHaveBeenCalledTimes(1)
    } finally {
      act(() => renderer?.unmount())
    }
  })
})
