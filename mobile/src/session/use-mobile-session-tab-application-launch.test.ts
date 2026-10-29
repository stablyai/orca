import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileSessionTab, SessionTabsResult } from './mobile-session-route-types'
import { launchedSelection, type PendingSessionSelection } from './pending-session-selection'
import { useMobileSessionTabApplication } from './use-mobile-session-tab-application'
import {
  mobileNativeChatDraftDestination,
  readMobileNativeChatDraftInputs,
  updateMobileNativeChatDraftInputs
} from './native-chat/composer/mobile-native-chat-draft-inputs'

import {
  mobileNativeChatLaunchDraftSeeds,
  readMobileNativeChatDraftEditGeneration,
  resetMobileNativeChatDraftStoreForTests,
  setMobileNativeChatDraftText
} from './native-chat/composer/mobile-native-chat-draft-store'

function terminalTab(id: string, terminal: string, isActive = false): MobileSessionTab {
  return { type: 'terminal', id, parentTabId: id, leafId: 'leaf', title: 'T', terminal, isActive }
}

const PANE = {
  tabId: 'b1d3c0de-0000-4000-8000-000000000001',
  leafId: 'b1d3c0de-0000-4000-8000-000000000002'
}

function reservedTerminalTab(terminal: string, isActive = false): MobileSessionTab {
  return {
    type: 'terminal',
    id: `${PANE.tabId}::${PANE.leafId}`,
    parentTabId: PANE.tabId,
    leafId: PANE.leafId,
    title: 'Claude',
    terminal,
    isActive
  }
}

function chatTab(id: string, sessionId: string): MobileSessionTab {
  return { type: 'agent-session', id, title: 'Claude', sessionId, agent: 'claude', isActive: false }
}

let version = 0
function snapshot(tabs: MobileSessionTab[], extra: Partial<SessionTabsResult> = {}) {
  version += 1
  const active = tabs.find((tab) => tab.isActive) ?? null
  return {
    worktree: 'workspace-1',
    publicationEpoch: 'host-epoch:client-navigation',
    snapshotVersion: version,
    tabs,
    activeTabId: active?.id ?? null,
    activeTabType: active?.type ?? null,
    ...extra
  }
}

function mutableRef<T>(current: T): { current: T } {
  return { current }
}

function scope(pending: PendingSessionSelection | null) {
  const sendRequest = vi.fn(async () => ({
    id: 'x',
    ok: true as const,
    result: {},
    _meta: { runtimeId: 'r' }
  }))
  const client: Pick<RpcClient, 'sendRequest'> = { sendRequest }
  return {
    sendRequest,
    state: {
      hostId: 'host',
      worktreeId: 'workspace-1',
      setTerminals: vi.fn(),
      terminalsRef: { current: [] },
      setSessionTabs: vi.fn(),
      sessionTabsRef: mutableRef<MobileSessionTab[]>([]),
      appliedSnapshotMarkerRef: { current: { epoch: null, version: -1 } },
      appliedSessionTabsRevisionRef: { current: 0 },
      closedTabTombstonesRef: { current: new Map() },
      reconcileBufferedDraftsRef: { current: vi.fn() },
      setTerminalsLoaded: vi.fn(),
      defaultTerminalHandlesToLiveInput: vi.fn(),
      setActiveHandle: vi.fn(),
      setActiveSessionTabId: vi.fn(),
      activeSessionTabIdRef: mutableRef<string | null>('tab-old'),
      selectedSessionTabIdRef: mutableRef<string | null>('tab-old'),
      markdownDocsRef: { current: new Map() },
      initializedHandlesRef: { current: new Set<string>() },
      terminalDiagnosticsRef: { current: { tabsApplied: vi.fn() } },
      activeHandleRef: mutableRef<string | null>('term_old'),
      activeSessionTabTypeRef: { current: 'terminal' },
      pendingSelectionRef: { current: pending },
      pendingBrowserFocusPageIdRef: { current: null },
      initialSessionAutoCreateRef: { current: { sawSessionTabs: true } },
      unsubscribeTerminal: vi.fn(),
      subscribeToTerminal: vi.fn(),
      lastKnownTerminalCountRef: { current: 0 },
      clientRef: { current: client },
      creatingTerminalRef: mutableRef<string | null>('l1'),
      setCreating: vi.fn()
    }
  }
}

let renderer: ReactTestRenderer | undefined
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = undefined
  vi.restoreAllMocks()
  resetMobileNativeChatDraftStoreForTests()
})

function mount(state: ReturnType<typeof scope>['state']) {
  let model: ReturnType<typeof useMobileSessionTabApplication> | undefined
  function Harness() {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the scope carries every member applySessionTabs reads; a missing one throws on use.
    model = useMobileSessionTabApplication(state as never)
    return null
  }
  act(() => {
    renderer = create(createElement(Harness))
  })
  return (result: SessionTabsResult) => model!.applySessionTabs(result)
}

function activations(sendRequest: ReturnType<typeof scope>['sendRequest']): unknown[] {
  return sendRequest.mock.calls.flatMap((call: unknown[]) =>
    call[0] === 'session.tabs.activate' ? [call[1]] : []
  )
}

it.each([10, 100])('retires %i missing tab input scopes after accepted inventory', (count) => {
  const { state } = scope(null)
  const apply = mount(state)
  const retired = Array.from({ length: count }, (_, index) => `host\0workspace-1\0gone-${index}`)
  const retained = [
    'host\0workspace-1\0live',
    'other\0workspace-1\0gone',
    'host\0folder:other\0gone'
  ]
  const destinations = retired.map(mobileNativeChatDraftDestination)
  for (const key of [...retired, ...retained]) {
    updateMobileNativeChatDraftInputs(key, (current) => ({
      ...current,
      images: [
        {
          id: key,
          path: '/remote.png',
          previewUri: `data:image/png;base64,${'a'.repeat(32 * 1024)}`
        }
      ]
    }))
  }
  apply(snapshot([]))
  for (const key of retired) {
    expect(readMobileNativeChatDraftInputs(key).images).toHaveLength(1)
  }
  const next = snapshot([terminalTab('live', 'live', true)])
  expect(apply({ ...next, snapshotVersion: -1 }).accepted).toBe(false)
  for (const key of retired) {
    expect(readMobileNativeChatDraftInputs(key).images).toHaveLength(1)
  }
  expect(apply(next).accepted).toBe(true)
  for (let index = 0; index < count; index++) {
    expect(readMobileNativeChatDraftInputs(retired[index]!).images).toHaveLength(0)
    expect(destinations[index]!.active).toBe(false)
    updateMobileNativeChatDraftInputs(destinations[index]!, (current) => ({
      ...current,
      pending: 10
    }))
    expect(readMobileNativeChatDraftInputs(retired[index]!).pending).toBeUndefined()
  }
  for (const key of retained) {
    expect(readMobileNativeChatDraftInputs(key).images).toHaveLength(1)
  }
})

it.each([10, 100])(
  'retires %i absent text scopes only after an accepted nonempty inventory',
  (count) => {
    const { state } = scope(null)
    const apply = mount(state)
    const retired = Array.from({ length: count }, (_, index) => `host\0workspace-1\0text-${index}`)
    const retained = [
      'host\0workspace-1\0live',
      'host\0other-workspace\0text',
      'other-host\0workspace-1\0text'
    ]
    for (const key of [...retired, ...retained]) {
      setMobileNativeChatDraftText(key, 'draft '.repeat(2048))
      mobileNativeChatLaunchDraftSeeds.set(key, null)
    }
    apply(snapshot([]))
    expect(retired.every((key) => readMobileNativeChatDraftEditGeneration(key) === 1)).toBe(true)
    const next = snapshot([terminalTab('live', 'live', true)])
    expect(apply({ ...next, snapshotVersion: -1 }).accepted).toBe(false)
    expect(retired.every((key) => mobileNativeChatLaunchDraftSeeds.has(key))).toBe(true)
    expect(apply(next).accepted).toBe(true)
    expect(retired.filter((key) => readMobileNativeChatDraftEditGeneration(key) > 0)).toHaveLength(
      0
    )
    expect(retired.filter((key) => mobileNativeChatLaunchDraftSeeds.has(key))).toHaveLength(0)
    expect(retained.every((key) => readMobileNativeChatDraftEditGeneration(key) === 1)).toBe(true)
    expect(retained.every((key) => mobileNativeChatLaunchDraftSeeds.has(key))).toBe(true)
  }
)

it('keeps host-published draft owners hidden by optimistic close tombstones', () => {
  vi.spyOn(Date, 'now').mockReturnValue(1_000)
  const { state } = scope(null)
  const apply = mount(state)
  const key = 'host\0workspace-1\0pending-close'
  const destination = mobileNativeChatDraftDestination(key)
  updateMobileNativeChatDraftInputs(destination, (current) => ({ ...current, pending: 1 }))
  const inputs = readMobileNativeChatDraftInputs(key)
  setMobileNativeChatDraftText(key, 'still live on host')
  mobileNativeChatLaunchDraftSeeds.set(key, null)
  state.closedTabTombstonesRef.current.set('pending-close', 11_000)
  const tabs = [
    terminalTab('pending-close', 'term-pending'),
    terminalTab('live', 'term-live', true)
  ]
  expect(apply(snapshot(tabs)).accepted).toBe(true)
  expect(destination.active).toBe(true)
  expect(readMobileNativeChatDraftInputs(key)).toBe(inputs)
  expect(readMobileNativeChatDraftEditGeneration(key)).toBe(1)
  expect(mobileNativeChatLaunchDraftSeeds.has(key)).toBe(true)
  expect(apply(snapshot([tabs[1]!])).accepted).toBe(true)
  expect(destination.active).toBe(false)
  expect(readMobileNativeChatDraftEditGeneration(key)).toBe(0)
  expect(mobileNativeChatLaunchDraftSeeds.has(key)).toBe(false)
})

it.each([
  { agentSessionsUnverifiable: true },
  { clientHostedPagesUnreconciled: true },
  { publicationEpoch: 'mobile-local:pending' },
  { publicationEpoch: 'none' },
  { publicationEpoch: 'none:client-navigation' }
] as const)('retains draft owners until a complete host inventory: %j', (extra) => {
  const { state } = scope(null)
  const apply = mount(state)
  const key = 'host\0workspace-1\0unverifiable'
  const destination = mobileNativeChatDraftDestination(key)
  setMobileNativeChatDraftText(key, 'not proven absent')
  mobileNativeChatLaunchDraftSeeds.set(key, null)
  const live = terminalTab('live', 'term-live', true)
  expect(apply(snapshot([live], extra)).accepted).toBe(true)
  expect(destination.active).toBe(true)
  expect(readMobileNativeChatDraftEditGeneration(key)).toBe(1)
  expect(mobileNativeChatLaunchDraftSeeds.has(key)).toBe(true)
  expect(apply(snapshot([live])).accepted).toBe(true)
  expect(destination.active).toBe(false)
  expect(readMobileNativeChatDraftEditGeneration(key)).toBe(0)
  expect(mobileNativeChatLaunchDraftSeeds.has(key)).toBe(false)
})

it('keeps a phone-created tab draft through host snapshots that have not listed it yet', () => {
  const { state } = scope(null)
  const apply = mount(state)
  const live = terminalTab('live', 'term-live', true)
  expect(apply(snapshot([live])).accepted).toBe(true)
  const created = terminalTab('created', 'term-created', true)
  const key = 'host\0workspace-1\0created'
  state.sessionTabsRef.current = [...state.sessionTabsRef.current, created]
  state.pendingSelectionRef.current = { kind: 'terminal', handle: 'term-created', tabId: 'created' }
  setMobileNativeChatDraftText(key, 'typed before the host listed it')
  expect(apply(snapshot([live])).accepted).toBe(true)
  state.pendingSelectionRef.current = null
  state.activeSessionTabIdRef.current = 'live'
  expect(apply(snapshot([live])).accepted).toBe(true)
  expect(readMobileNativeChatDraftEditGeneration(key)).toBe(1)
  expect(apply(snapshot([live, created])).accepted).toBe(true)
  expect(apply(snapshot([live])).accepted).toBe(true)
  expect(readMobileNativeChatDraftEditGeneration(key)).toBe(0)
})

describe('landing on a launched tab', () => {
  it('records a launched terminal as this device’s pick on the host once its tab arrives', () => {
    const { state, sendRequest } = scope(launchedSelection('l1', { handle: 'term_new' }))
    const apply = mount(state)
    const old = terminalTab('tab-old', 'term_old', true)

    apply(snapshot([old]))
    expect(activations(sendRequest)).toEqual([])

    apply(snapshot([old, terminalTab('tab-new', 'term_new')]))
    expect(activations(sendRequest)).toEqual([
      {
        worktree: 'id:workspace-1',
        tabId: 'tab-new',
        notifyClients: false,
        navigation: 'caller',
        intent: 'user'
      }
    ])
    expect(state.setActiveSessionTabId).toHaveBeenLastCalledWith('tab-new')
    expect(state.unsubscribeTerminal).toHaveBeenCalledWith('term_old')
    expect(state.subscribeToTerminal).toHaveBeenLastCalledWith('term_new')

    apply(snapshot([old, terminalTab('tab-new', 'term_new')]))
    expect(activations(sendRequest)).toHaveLength(1)
  })

  it('records a launched chat, found by its session, by the tab id the host gave it', () => {
    const { state, sendRequest } = scope(launchedSelection('l1', { sessionId: 'claude_s1' }))
    const apply = mount(state)

    apply(snapshot([terminalTab('tab-old', 'term_old', true), chatTab('opaque-7', 'claude_s1')]))

    expect(activations(sendRequest)).toEqual([expect.objectContaining({ tabId: 'opaque-7' })])
    expect(state.setActiveSessionTabId).toHaveBeenLastCalledWith('opaque-7')
  })

  it('leaves the host’s choice alone when it moved this device itself', () => {
    const { state, sendRequest } = scope(launchedSelection('l1', { handle: 'term_new' }))
    const apply = mount(state)

    apply(
      snapshot([terminalTab('tab-old', 'term_old', true), terminalTab('tab-new', 'term_new')], {
        navigationIntent: 'follow'
      })
    )

    expect(activations(sendRequest)).toEqual([])
    expect(state.setActiveSessionTabId).toHaveBeenLastCalledWith('tab-old')
  })

  it('frees the + lock when the tab lands, not when the host replies', () => {
    const { state } = scope(launchedSelection('l1', { pane: PANE }, null))
    const apply = mount(state)
    const old = terminalTab('tab-old', 'term_old', true)

    apply(snapshot([old]))
    expect(state.creatingTerminalRef.current).toBe('l1')
    expect(state.setCreating).not.toHaveBeenCalled()

    apply(snapshot([old, reservedTerminalTab('term_new')]))
    expect(state.creatingTerminalRef.current).toBeNull()
    expect(state.setCreating).toHaveBeenCalledWith(false)
  })

  it("leaves a newer launch's lock alone", () => {
    const { state } = scope(launchedSelection('l1', { pane: PANE }, null))
    state.creatingTerminalRef.current = 'l2'
    const apply = mount(state)

    apply(snapshot([terminalTab('tab-old', 'term_old', true), reservedTerminalTab('term_new')]))

    expect(state.creatingTerminalRef.current).toBe('l2')
    expect(state.setCreating).not.toHaveBeenCalled()
  })

  it('lands in an empty session whose only tab the host selected before replying', () => {
    const { state, sendRequest } = scope(launchedSelection('l1', { pane: PANE }, null))
    state.activeSessionTabIdRef.current = null
    state.selectedSessionTabIdRef.current = null
    state.activeHandleRef.current = null
    const apply = mount(state)

    apply(snapshot([reservedTerminalTab('term_new', true)]))

    expect(activations(sendRequest)).toEqual([
      expect.objectContaining({ tabId: `${PANE.tabId}::${PANE.leafId}` })
    ])
    expect(state.setActiveSessionTabId).toHaveBeenLastCalledWith(`${PANE.tabId}::${PANE.leafId}`)
    expect(state.subscribeToTerminal).toHaveBeenLastCalledWith('term_new')
    expect(state.creatingTerminalRef.current).toBeNull()
  })
})
