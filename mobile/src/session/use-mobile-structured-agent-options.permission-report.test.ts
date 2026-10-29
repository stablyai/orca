import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { StructuredAgentSessionMutate } from './mobile-structured-agent-session-rpc'

const feed = vi.hoisted(() => {
  const listeners = new Set<() => void>()
  let snapshot = new Map<string, unknown>()
  return {
    report(runtimePermission: { fence: number; mode: string | null } | null) {
      snapshot = new Map([['session-1', { sessionId: 'session-1', runtimePermission }]])
      for (const listener of listeners) {
        listener()
      }
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => snapshot
  }
})

vi.mock('./mobile-structured-session-status-feed', () => ({
  mobileStructuredSessionStatusFeed: () => feed
}))

import { useMobileStructuredAgentOptions } from './use-mobile-structured-agent-options'

let savedMode = 'ask'
const client: RpcClient = {
  sendRequest: async (method: string) =>
    method === 'agentSession.options'
      ? {
          id: 'rpc-1',
          ok: true as const,
          result: {
            models: [{ id: 'claude-live', label: 'Claude', isDefault: true, efforts: [] }],
            current: {
              model: 'claude-live',
              permissionMode: savedMode,
              reportedPermissionMode: 'ask'
            }
          },
          _meta: { runtimeId: 'runtime-1' }
        }
      : {
          id: 'rpc-1',
          ok: false as const,
          error: { code: 'method_not_found', message: 'Unknown method' },
          _meta: { runtimeId: 'runtime-1' }
        },
  subscribe: () => () => {},
  updateTerminalSubscriptionViewport: () => {},
  getState: () => 'connected',
  getReconnectAttempt: () => 0,
  getLastConnectedAt: () => null,
  onStateChange: () => () => {},
  notifyForeground: () => {},
  close: () => {}
}

const mutate: StructuredAgentSessionMutate = vi.fn()

describe('a phone pick while the agent from the last turn is still running', () => {
  it('shows the pick until the agent reports again', async () => {
    vi.mocked(mutate).mockImplementation(async () => {
      savedMode = 'full-access'
      return {
        status: 'accepted',
        value: { options: { permissionMode: 'full-access' } },
        sameFence: true
      }
    })
    feed.report({ fence: 1, mode: 'ask' })
    const rendered: { current: ReturnType<typeof useMobileStructuredAgentOptions> | null } = {
      current: null
    }
    function Probe(): null {
      rendered.current = useMobileStructuredAgentOptions({
        agent: 'claude',
        client,
        sessionId: 'session-1',
        enabled: true,
        fence: 1,
        mutate,
        optionStamp: 'claude-live|ask',
        turnId: null,
        hostSupport: { permissionModes: true, permissionOwn: true, statusFeed: true }
      })
      return null
    }
    const settle = () =>
      act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })
    const permission = () => {
      const entry = rendered.current?.optionSnapshot.find((row) => row.id === 'permissionMode')
      return entry?.kind.type === 'select' ? entry.kind.currentValue : null
    }
    let renderer: ReactTestRenderer | null = null
    await act(async () => {
      renderer = create(createElement(Probe))
    })
    await settle()
    expect(permission()).toBe('ask')

    await act(async () => {
      await rendered.current?.setStructuredOption('permissionMode', 'full-access')
    })
    await settle()
    await act(async () => feed.report({ fence: 1, mode: 'ask' }))
    expect(permission()).toBe('full-access')

    await act(async () => feed.report(null))
    await act(async () => feed.report({ fence: 1, mode: 'ask' }))
    expect(permission()).toBe('ask')
    await act(async () => renderer?.unmount())
  })
})
