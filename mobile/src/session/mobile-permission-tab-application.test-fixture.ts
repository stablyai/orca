import type { Dispatch, SetStateAction } from 'react'
import { vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { MobileTerminalDiagnostics } from './mobile-terminal-diagnostics'
import type { MobileSessionTab } from './mobile-session-route-types'
import type { MobileSessionTabApplicationScope } from './mobile-session-tab-application-scope'
import { createInitialSessionAutoCreateState } from './use-initial-session-terminal-autocreate'

export function permissionTabScope(
  setSessionTabs: Dispatch<SetStateAction<MobileSessionTab[]>>,
  client: RpcClient
): MobileSessionTabApplicationScope {
  return {
    setSessionTabs,
    setTerminals: vi.fn(),
    terminalsRef: { current: [] },
    sessionTabsRef: { current: [] },
    appliedSnapshotMarkerRef: { current: { epoch: null, version: -1 } },
    appliedSessionTabsRevisionRef: { current: 0 },
    closedTabTombstonesRef: { current: new Map() },
    reconcileBufferedDraftsRef: { current: vi.fn() },
    setTerminalsLoaded: vi.fn(),
    defaultTerminalHandlesToLiveInput: vi.fn(),
    setActiveHandle: vi.fn(),
    setActiveSessionTabId: vi.fn(),
    activeSessionTabIdRef: { current: null },
    selectedSessionTabIdRef: { current: null },
    markdownDocsRef: { current: new Map() },
    initializedHandlesRef: { current: new Set() },
    terminalDiagnosticsRef: { current: new MobileTerminalDiagnostics() },
    activeHandleRef: { current: null },
    activeSessionTabTypeRef: { current: null },
    pendingSelectionRef: { current: null },
    pendingBrowserFocusPageIdRef: { current: null },
    initialSessionAutoCreateRef: { current: createInitialSessionAutoCreateState() },
    unsubscribeTerminal: vi.fn(),
    subscribeToTerminal: vi.fn(),
    lastKnownTerminalCountRef: { current: 0 },
    clientRef: { current: client },
    creatingTerminalRef: { current: null },
    setCreating: vi.fn()
  }
}
