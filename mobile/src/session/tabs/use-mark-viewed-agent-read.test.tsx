import { createElement, useEffect } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { MobileSessionTab } from './mobile-session-tabs'

const screen = vi.hoisted(() => ({
  focused: true,
  appState: 'active',
  appListeners: new Set<(state: string) => void>()
}))

vi.mock('react-native', () => ({
  AppState: {
    get currentState() {
      return screen.appState
    },
    addEventListener: (_event: string, listener: (state: string) => void) => {
      screen.appListeners.add(listener)
      return { remove: () => screen.appListeners.delete(listener) }
    }
  }
}))

vi.mock('expo-router', () => ({
  useFocusEffect: (effect: () => void | (() => void)) =>
    useEffect(() => (screen.focused ? effect() : undefined), [effect, screen.focused])
}))

import { useMarkViewedAgentRead } from './use-mark-viewed-agent-read'

function tab(unread: boolean): MobileSessionTab {
  return {
    type: 'terminal',
    id: 'leaf-a',
    title: 'claude',
    parentTabId: 'tab-a',
    leafId: '11111111-1111-4111-8111-111111111111',
    terminal: 'term-a',
    isActive: true,
    ...(unread ? { unread: true as const } : {})
  }
}

function Session({ client, activeTab }: { client: RpcClient; activeTab: MobileSessionTab }) {
  useMarkViewedAgentRead(client, 'connected', activeTab)
  return null
}

function setAppState(state: string): void {
  screen.appState = state
  for (const listener of screen.appListeners) {
    listener(state)
  }
}

describe('reading the agent on the active tab', () => {
  let renderer: ReactTestRenderer | null = null
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    screen.focused = true
    screen.appState = 'active'
  })

  function mount(unread: boolean, refuseFirst = false) {
    const reads: unknown[] = []
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook's write reads only sendRequest.
    const client = {
      sendRequest: async (method: string, params: unknown) => {
        reads.push({ method, params })
        if (refuseFirst && reads.length === 1) {
          throw new Error('agent_activity_needs_desktop_window')
        }
        return { id: '1', ok: true, result: { applied: true } }
      }
    } as unknown as RpcClient
    act(() => {
      renderer = create(createElement(Session, { client, activeTab: tab(unread) }))
    })
    const show = async (next: boolean) => {
      await act(async () =>
        renderer!.update(createElement(Session, { client, activeTab: tab(next) }))
      )
    }
    return { reads, show }
  }

  it('marks an unread turn read once, and again only after the desktop clears it', async () => {
    const { reads, show } = mount(true)
    await act(async () => {})
    expect(reads).toEqual([
      {
        method: 'agentActivity.setRead',
        params: { paneKeys: ['tab-a:11111111-1111-4111-8111-111111111111'], read: true }
      }
    ])

    // The verdict has not cleared yet, and the app comes back from the background: still one write.
    await show(true)
    await act(async () => setAppState('background'))
    await act(async () => setAppState('active'))
    expect(reads).toHaveLength(1)

    await show(false)
    await show(true)
    expect(reads).toHaveLength(2)
  })

  it('tries a refused read again on the next foreground, not in a loop', async () => {
    const { reads } = mount(true, true)
    await act(async () => {})
    expect(reads).toHaveLength(1)
    await act(async () => setAppState('background'))
    await act(async () => setAppState('active'))
    expect(reads).toHaveLength(2)
  })

  it('leaves the bell alone while another screen covers the session', () => {
    screen.focused = false
    const { reads } = mount(true)
    expect(reads).toEqual([])
  })
})
