import { createElement } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it } from 'vitest'
import { createOrcaQueryClient } from '../../query/orca-query-client'
import { HostStatusGatesContext } from '../../components/host-connection/host-protocol-gates-context'
import { mountFixture } from '../../test-support/rpc-recording/react-mounting/recorder-fixture-shape'
import type { HostStatusGates } from '../../transport/connection/host-status-gates'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { RpcResponse } from '../../transport/rpc/rpc-wire-types'
import type { MobileSessionTab, SessionTabsResult } from './mobile-session-tabs'
import type { PendingSessionSelection } from './pending-session-selection'
import { useMobileSessionCloseActions } from './use-mobile-session-close-actions'
import { useMobileSessionTabApplication } from './use-mobile-session-tab-application'

let renderer: ReactTestRenderer | null = null

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})

function terminalTab(id: string, handle: string, isActive: boolean): MobileSessionTab {
  return { type: 'terminal', id, title: 'Terminal', terminal: handle, isActive }
}

function snapshot(version: number, tabs: MobileSessionTab[]): SessionTabsResult {
  return mountFixture<SessionTabsResult>({
    worktree: 'wt-1',
    publicationEpoch: 'host-epoch',
    snapshotVersion: version,
    tabs
  })
}

function mountSession(pendingSelection: PendingSessionSelection | null) {
  let replyToClose: (response: RpcResponse) => void = () => {}
  const client = mountFixture<RpcClient>({
    sendRequest: () =>
      new Promise<RpcResponse>((resolve) => {
        replyToClose = resolve
      }),
    getState: () => 'connected',
    onStateChange: () => () => {},
    getLastConnectedAt: () => 0
  })
  const state: { activeHandle: string | null } = { activeHandle: null }
  const pendingSelectionRef: { current: PendingSessionSelection | null } = { current: null }
  let model!: ReturnType<typeof useMobileSessionCloseActions> &
    ReturnType<typeof useMobileSessionTabApplication>
  function Harness() {
    const scope = mountFixture<
      Parameters<typeof useMobileSessionTabApplication>[0] &
        Parameters<typeof useMobileSessionCloseActions>[0]
    >({
      hostId: 'host-1',
      worktreeId: 'wt-1',
      client,
      clientRef: { current: null },
      setTerminals: () => {},
      setSessionTabs: () => {},
      setFileDocs: () => {},
      setMarkdownDocs: () => {},
      setTerminalsLoaded: () => {},
      setActiveSessionTabId: () => {},
      setActiveHandle: (value) => {
        state.activeHandle = typeof value === 'function' ? value(state.activeHandle) : value
      },
      setCreating: () => {},
      setSplitTerminalHandles: () => {},
      sessionTabsRef: { current: [] },
      terminalsRef: { current: [] },
      activeHandleRef: { current: null },
      activeSessionTabIdRef: { current: null },
      pendingSelectionRef,
      appliedSnapshotMarkerRef: { current: { epoch: null, version: 0 } },
      appliedSessionTabsRevisionRef: { current: 0 },
      closedTabTombstonesRef: { current: new Map() },
      selectedSessionTabIdRef: { current: null },
      markdownDocsRef: { current: new Map() },
      terminalDiagnosticsRef: { current: { tabsApplied: () => {} } },
      activeSessionTabTypeRef: { current: null },
      pendingBrowserFocusPageIdRef: { current: null },
      initialSessionAutoCreateRef: { current: { sawSessionTabs: false } },
      lastKnownTerminalCountRef: { current: 0 },
      creatingTerminalRef: { current: null },
      terminalRefs: { current: new Map() },
      forgetLastSessionTab: () => {},
      subscribeToTerminal: () => true,
      unsubscribeTerminal: () => {},
      showToast: () => {}
    })
    model = { ...useMobileSessionTabApplication(scope), ...useMobileSessionCloseActions(scope) }
    return null
  }
  const gates = mountFixture<HostStatusGates>({ hostCapabilities: [] })
  act(() => {
    renderer = create(
      createElement(
        QueryClientProvider,
        { client: createOrcaQueryClient() },
        createElement(HostStatusGatesContext.Provider, { value: gates }, createElement(Harness))
      )
    )
  })
  act(() => {
    model.applySessionTabs(snapshot(1, [terminalTab('tab-1', 'pty-1', true)]))
  })
  pendingSelectionRef.current = pendingSelection
  return { model, state, reply: (response: RpcResponse) => replyToClose(response) }
}

// The host can publish the empty strip before it answers the close (#48612).
async function closeLastTerminalBehindEmptySnapshot(pick: PendingSessionSelection | null) {
  const { model, state, reply } = mountSession(pick)
  expect(state.activeHandle).toBe('pty-1')

  let closing!: Promise<void>
  act(() => {
    closing = model.handleCloseSessionTab(terminalTab('tab-1', 'pty-1', true))
  })
  act(() => {
    model.applySessionTabs(snapshot(2, []))
  })
  await act(async () => {
    reply({ id: '1', ok: true, result: { closed: true } })
    await closing
  })
  expect(state.activeHandle).toBeNull()

  act(() => {
    model.applySessionTabs(snapshot(3, []))
  })
  expect(state.activeHandle).toBeNull()
}

it('shows the empty session after the last terminal closes', async () => {
  await closeLastTerminalBehindEmptySnapshot(null)
})

it('shows the empty session after closing a terminal the phone just picked', async () => {
  await closeLastTerminalBehindEmptySnapshot({ kind: 'terminal', handle: 'pty-1', tabId: 'tab-1' })
})
