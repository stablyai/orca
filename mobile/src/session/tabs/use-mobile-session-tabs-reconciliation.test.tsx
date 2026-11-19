import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { WorkspaceViewers } from '@orca/test-host/main/runtime/sidebar-inputs/temporal/workspace-viewers'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'

const screen = vi.hoisted(() => ({ focused: true }))
const application = vi.hoisted(() => ({
  state: 'active',
  listeners: new Set<(state: string) => void>()
}))
vi.mock('expo-router', async () => {
  const { useEffect } = await import('react')
  return {
    useFocusEffect: (callback: () => void | (() => void)) =>
      useEffect(() => (screen.focused ? callback() : undefined), [callback, screen.focused])
  }
})
vi.mock('react-native', () => ({
  AppState: {
    get currentState() {
      return application.state
    },
    addEventListener: (_event: string, listener: (state: string) => void) => {
      application.listeners.add(listener)
      return { remove: () => application.listeners.delete(listener) }
    }
  }
}))
vi.mock('../../terminal/session/inventory/use-mobile-terminal-inventory-recovery', () => {
  const noop = () => {}
  return {
    useMobileTerminalInventoryRecovery: () => ({
      activateTerminalInventoryRecovery: noop,
      isCertifiedTerminalSweepDue: () => false,
      refreshTerminalInventory: async () => false,
      requestTerminalInventoryRecovery: noop,
      resetCertifiedTerminalSweep: noop,
      resumePendingTerminalInventoryRecovery: noop,
      suspendTerminalInventoryRecovery: noop
    })
  }
})

import { useMobileSessionTabsReconciliation } from './use-mobile-session-tabs-reconciliation'

const WORKSPACE = 'repo-1::/workspace/orca'
const PANE = 'tab-a:11111111-1111-4111-8111-111111111111'

describe('mobile session viewing presence', () => {
  it.each(['workspace list', 'background'])(
    'allows completion unread after leaving a retained conversation for %s',
    async (destination) => {
      screen.focused = true
      application.state = 'active'
      const viewers = new WorkspaceViewers(() => 1000)
      const client: RpcClient = {
        subscribe: () => viewers.openPhoneSession(WORKSPACE),
        sendRequest: async () => ({
          id: 'session-tabs',
          ok: false,
          error: { code: 'unsupported', message: 'Unsupported' }
        }),
        updateTerminalSubscriptionViewport: () => {},
        getState: () => 'connected',
        getReconnectAttempt: () => 0,
        getLastConnectedAt: () => 1000,
        onStateChange: () => () => {},
        notifyForeground: () => {},
        close: () => {}
      }
      const params = {
        client,
        connState: 'connected' as const,
        worktreeId: WORKSPACE,
        applySessionTabs: () => ({ accepted: false as const }),
        consumeAcceptedSessionTabs: () => {},
        fetchTerminals: async () => false,
        terminalInventoryRecoveryScopeKey: WORKSPACE,
        hasRecoveryNeed: () => false
      }
      function Session(): null {
        useMobileSessionTabsReconciliation(params)
        return null
      }
      let tree: ReactTestRenderer | undefined
      try {
        await act(async () => {
          tree = create(createElement(Session))
        })
        expect(viewers.isViewing(WORKSPACE, PANE)).toBe(true)
        await act(async () => {
          if (destination === 'workspace list') {
            screen.focused = false
            tree?.update(createElement(Session))
          } else {
            application.state = 'background'
            for (const listener of application.listeners) {
              listener('background')
            }
          }
        })
        expect(viewers.isViewing(WORKSPACE, PANE)).toBe(false)
        await act(async () => {
          screen.focused = true
          application.state = 'active'
          if (destination === 'workspace list') {
            tree?.update(createElement(Session))
          } else {
            for (const listener of application.listeners) {
              listener('active')
            }
          }
        })
        expect(viewers.isViewing(WORKSPACE, PANE)).toBe(true)
      } finally {
        await act(async () => tree?.unmount())
      }
      expect(viewers.isViewing(WORKSPACE, PANE)).toBe(false)
    }
  )
})
