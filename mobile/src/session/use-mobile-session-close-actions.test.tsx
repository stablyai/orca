import { createElement, useRef, useState } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import type { RpcResponse } from '../transport/types'
import type { MobileSessionContentCreateActionsModel } from './use-mobile-session-content-create-actions'
import type { MobileSessionTab, Terminal } from './mobile-session-route-types'
import type { PendingSessionSelection } from './pending-session-selection'
import { useMobileSessionCloseActions } from './use-mobile-session-close-actions'
import {
  closeMobileNativeChatEditInputs,
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
import { mobileNativeChatScopeKey } from './native-chat/mobile-native-chat-scope-key'
import { resolveActiveSessionTab } from './active-session-tab'

const initial: Terminal[] = ['a', 'b', 'c'].map((handle) => ({
  handle,
  title: handle,
  isActive: handle === 'a'
}))

describe('legacy terminal close acknowledgments', () => {
  let renderer: ReactTestRenderer | null = null
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    resetMobileNativeChatDraftStoreForTests()
  })

  async function mount() {
    const client = new FakeSession('connected')
    const acknowledgments = new Map<string, (reply: RpcResponse) => void>()
    client.sendRequest.mockImplementation(
      (_method, params) =>
        new Promise<RpcResponse>((resolve) => {
          if (
            params &&
            typeof params === 'object' &&
            'terminal' in params &&
            typeof params.terminal === 'string'
          ) {
            acknowledgments.set(params.terminal, resolve)
          } else if (
            params &&
            typeof params === 'object' &&
            'tabId' in params &&
            typeof params.tabId === 'string'
          ) {
            acknowledgments.set(params.tabId, resolve)
          }
        })
    )
    const subscribe = vi.fn()
    const tabTombstones = new Map<string, number>()
    const setSessionTabs = vi.fn()
    const setActiveSessionTabId = vi.fn()
    const tabSelection: Pick<
      MobileSessionContentCreateActionsModel,
      'sessionTabsRef' | 'activeSessionTabIdRef' | 'selectedSessionTabIdRef' | 'pendingSelectionRef'
    > = {
      sessionTabsRef: { current: [] },
      activeSessionTabIdRef: { current: null },
      selectedSessionTabIdRef: { current: null },
      pendingSelectionRef: { current: null }
    }
    let current: {
      actions: ReturnType<typeof useMobileSessionCloseActions>
      terminals: Terminal[]
      activeHandle: string | null
      pending: PendingSessionSelection | null
      publish: (terminals: Terminal[]) => void
      select: (handle: string) => void
    } | null = null
    function Harness() {
      const [terminals, setTerminals] = useState(initial)
      const terminalsRef = useRef(initial)
      const [activeHandle, setActiveHandle] = useState<string | null>('a')
      const activeHandleRef = useRef<string | null>('a')
      const { pendingSelectionRef } = tabSelection
      const scope = {
        hostId: 'host',
        worktreeId: 'workspace',
        client,
        terminals,
        setTerminals,
        terminalsRef,
        activeHandleRef,
        setActiveHandle,
        setSessionTabs,
        setFileDocs: vi.fn(),
        setMarkdownDocs: vi.fn(),
        ...tabSelection,
        reconcileBufferedDraftsRef: { current: vi.fn() },
        closedTabTombstonesRef: { current: tabTombstones },
        clearTerminalLiveInputDefault: vi.fn(),
        setActiveSessionTabId,
        renameTarget: null,
        setRenameTarget: vi.fn(),
        terminalRefs: { current: new Map() },
        activeSessionTabTypeRef: { current: 'terminal' },
        pendingBrowserFocusPageIdRef: { current: null },
        scheduleDelayedAction: vi.fn(),
        unsubscribeTerminal: vi.fn(),
        subscribeToTerminal: subscribe,
        fetchTerminals: vi.fn()
      }
      const actions = useMobileSessionCloseActions(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The harness supplies every dependency read by this hook; unrelated route-model fields are not used.
        scope as unknown as MobileSessionContentCreateActionsModel
      )
      current = {
        actions,
        terminals,
        activeHandle,
        pending: pendingSelectionRef.current,
        publish: (next) => {
          terminalsRef.current = next
          setTerminals(next)
        },
        select: (handle) => {
          activeHandleRef.current = handle
          setActiveHandle(handle)
        }
      }
      return null
    }
    await act(async () => {
      renderer = create(createElement(Harness))
    })
    return {
      read() {
        if (!current) {
          throw new Error('Close harness did not render')
        }
        return current
      },
      subscribe,
      tabTombstones,
      setSessionTabs,
      setActiveSessionTabId,
      tabSelection,
      requests: client.sendRequest,
      async acknowledge(
        handle: string,
        operation: Promise<void>,
        accepted = true,
        result: unknown = { closed: true, retirementConfirmed: true }
      ) {
        await act(async () => {
          const resolve = acknowledgments.get(handle)
          if (!resolve) {
            throw new Error(`Missing close for ${handle}`)
          }
          resolve(
            accepted
              ? { id: `close-${handle}`, ok: true, result }
              : { id: `close-${handle}`, ok: false, error: { code: 'refused', message: 'Retry' } }
          )
          await operation
        })
      }
    }
  }

  it('clears the closed remembered identity after omission, preserving newer surface, handle and launch claims', async () => {
    const harness = await mount()
    const refs = harness.tabSelection
    const closed: MobileSessionTab = {
      type: 'agent-session',
      id: 'closed',
      sessionId: 'same-session',
      agent: 'codex',
      title: 'Closed',
      isActive: true
    }
    const fallback: MobileSessionTab = { ...closed, id: 'fallback', sessionId: 'other-session' }
    refs.sessionTabsRef.current = [closed, fallback]
    refs.activeSessionTabIdRef.current = closed.id
    refs.selectedSessionTabIdRef.current = closed.id
    refs.pendingSelectionRef.current = { kind: 'tab', tabId: closed.id }
    const operation = harness.read().actions.handleCloseSessionTab(closed)
    refs.sessionTabsRef.current = [fallback]
    const omission = resolveActiveSessionTab([fallback], {
      pendingActiveSessionTabId: null,
      selectedSessionTabId: refs.selectedSessionTabIdRef.current
    })
    expect(omission.retainSelectedSessionTabId).toBe(true)
    refs.activeSessionTabIdRef.current = omission.activeTab?.id ?? null
    await harness.acknowledge(closed.id, operation)
    expect(refs.selectedSessionTabIdRef.current).toBe(fallback.id)
    expect(refs.pendingSelectionRef.current).toBeNull()
    expect(refs.activeSessionTabIdRef.current).toBe(fallback.id)
    for (const pending of [
      { kind: 'tab', tabId: 'replacement' },
      { kind: 'terminal', handle: 'fresh-handle', tabId: closed.id },
      {
        kind: 'launched',
        lock: 'fresh-launch',
        surface: { pane: null, sessionId: null, handle: null },
        snapshotsLeft: null
      }
    ] satisfies PendingSessionSelection[]) {
      const close = harness.read().actions.handleCloseSessionTab(closed)
      refs.sessionTabsRef.current = []
      refs.activeSessionTabIdRef.current = 'replacement'
      refs.selectedSessionTabIdRef.current = 'replacement'
      refs.pendingSelectionRef.current = pending
      await harness.acknowledge(closed.id, close)
      expect(refs.selectedSessionTabIdRef.current).toBe('replacement')
      expect(refs.activeSessionTabIdRef.current).toBe('replacement')
      expect(refs.pendingSelectionRef.current).toEqual(
        pending.kind === 'terminal' ? { ...pending, tabId: null } : pending
      )
    }
    refs.selectedSessionTabIdRef.current = closed.id
    const pending = { kind: 'tab', tabId: closed.id } as const
    refs.pendingSelectionRef.current = pending
    const rejected = harness.read().actions.handleCloseSessionTab(closed)
    await harness.acknowledge(closed.id, rejected, false)
    expect(refs.selectedSessionTabIdRef.current).toBe(closed.id)
    expect(refs.pendingSelectionRef.current).toBe(pending)
  })

  it.each([
    ['a', 'b'],
    ['b', 'a']
  ] as const)(
    'keeps both acknowledged closes removed when replies arrive %s then %s',
    async (first, second) => {
      const harness = await mount()
      const actions = harness.read().actions
      const closes = {
        a: actions.handleCloseTerminal(initial[0]!),
        b: actions.handleCloseTerminal(initial[1]!)
      }
      expect(harness.requests.mock.calls).toEqual([
        ['terminal.close', { terminal: 'a' }],
        ['terminal.close', { terminal: 'b' }]
      ])
      await harness.acknowledge(first, closes[first])
      await harness.acknowledge(second, closes[second])
      expect(harness.read().terminals.map((terminal) => terminal.handle)).toEqual(['c'])
      expect(harness.read().activeHandle).toBe('c')
      expect(harness.read().pending).toEqual({ kind: 'terminal', handle: 'c', tabId: null })
    }
  )

  it('preserves fresh terminal metadata and a new active choice while a close is pending', async () => {
    const harness = await mount()
    const close = harness.read().actions.handleCloseTerminal(initial[0]!)
    expect(harness.requests.mock.calls).toEqual([['terminal.close', { terminal: 'a' }]])
    act(() => {
      harness.read().publish([
        { ...initial[1]!, title: 'Renamed while closing' },
        { handle: 'd', title: 'New terminal', isActive: true }
      ])
      harness.read().select('d')
    })
    await harness.acknowledge('a', close)
    expect(harness.read().terminals.map(({ handle, title }) => ({ handle, title }))).toEqual([
      { handle: 'b', title: 'Renamed while closing' },
      { handle: 'd', title: 'New terminal' }
    ])
    expect(harness.read().activeHandle).toBe('d')
    expect(harness.subscribe).not.toHaveBeenCalled()
  })

  it.each([10, 100])('releases input previews for %i confirmed closed tabs', async (count) => {
    const harness = await mount()
    const scopes = Array.from({ length: count }, (_, index) => `host\0workspace\0closed-${index}`)
    const previewUri = `data:image/png;base64,${'a'.repeat(32 * 1024)}`
    const destinations = scopes.map(mobileNativeChatDraftDestination)
    const parked = mobileNativeChatScopeKey('host', 'workspace', 'parked')!
    for (const scope of [...scopes, parked]) {
      updateMobileNativeChatDraftInputs(scope, (current) => ({
        ...current,
        images: [{ id: scope, path: '/remote/image.png', previewUri }]
      }))
    }
    for (let index = 0; index < count; index++) {
      const id = `closed-${index}`
      const operation = harness.read().actions.handleCloseSessionTab({
        type: 'terminal',
        id,
        title: id,
        isActive: false,
        terminal: id
      })
      expect(readMobileNativeChatDraftInputs(scopes[index]!).images).toHaveLength(1)
      await harness.acknowledge(id, operation)
    }
    for (let index = 0; index < count; index++) {
      expect(readMobileNativeChatDraftInputs(scopes[index]!).images).toHaveLength(0)
      expect(destinations[index]!.active).toBe(false)
      updateMobileNativeChatDraftInputs(destinations[index]!, (current) => ({
        ...current,
        images: [{ id: 'late', path: '/late.png', previewUri }]
      }))
      expect(readMobileNativeChatDraftInputs(scopes[index]!).images).toHaveLength(0)
    }
    expect(readMobileNativeChatDraftInputs(parked).images).toHaveLength(1)
  })

  it.each([10, 100])(
    'retires text, revisions and launch seeds for %i confirmed closed tabs',
    async (count) => {
      const harness = await mount()
      const scopes = Array.from({ length: count }, (_, index) => `host\0workspace\0text-${index}`)
      const parked = 'host\0workspace\0parked-text'
      const text = 'draft '.repeat(2048)
      for (const key of [...scopes, parked]) {
        setMobileNativeChatDraftText(key, text)
        mobileNativeChatLaunchDraftSeeds.set(key, { text, createdAt: 1 })
      }
      for (let index = 0; index < count; index++) {
        const id = `text-${index}`
        const operation = harness.read().actions.handleCloseSessionTab({
          type: 'terminal',
          id,
          title: id,
          isActive: false,
          terminal: id
        })
        expect(readMobileNativeChatDraftEditGeneration(scopes[index]!)).toBe(1)
        await harness.acknowledge(id, operation)
      }
      expect(scopes.filter((key) => readMobileNativeChatDraftEditGeneration(key) > 0)).toHaveLength(
        0
      )
      expect(scopes.filter((key) => mobileNativeChatLaunchDraftSeeds.has(key))).toHaveLength(0)
      expect(readMobileNativeChatDraftEditGeneration(parked)).toBe(1)
      expect(mobileNativeChatLaunchDraftSeeds.get(parked)?.text).toBe(text)
    }
  )

  it('preserves input previews when the host refuses a close', async () => {
    const harness = await mount()
    const scope = 'host\0workspace\0refused'
    const destination = mobileNativeChatDraftDestination(scope)
    updateMobileNativeChatDraftInputs(destination, (current) => ({ ...current, pending: 1 }))
    setMobileNativeChatDraftText(scope, 'keep refused text')
    mobileNativeChatLaunchDraftSeeds.set(scope, null)
    const operation = harness.read().actions.handleCloseSessionTab({
      type: 'terminal',
      id: 'refused',
      title: 'Refused',
      isActive: false,
      terminal: 'refused'
    })
    await harness.acknowledge('refused', operation, false)
    expect(destination.active).toBe(true)
    expect(readMobileNativeChatDraftInputs(scope).pending).toBe(1)
    expect(readMobileNativeChatDraftEditGeneration(scope)).toBe(1)
    expect(mobileNativeChatLaunchDraftSeeds.has(scope)).toBe(true)
  })

  it.each([
    ['refused', { closed: true, refused: true, refusalReason: 'unknown-liveness' }],
    ['refused receipt', { closed: true, refused: true, retirementConfirmed: true }],
    ['legacy', {}],
    ['invalid receipt', { closed: false, retirementConfirmed: true }]
  ] as const)('preserves every draft owner for a %s close reply', async (kind, result) => {
    const harness = await mount()
    const key = 'host\0workspace\0uncertain'
    const destination = mobileNativeChatDraftDestination(key)
    updateMobileNativeChatDraftInputs(destination, (current) => ({ ...current, pending: 1 }))
    const inputs = readMobileNativeChatDraftInputs(key)
    setMobileNativeChatDraftText(key, 'keep this draft')
    mobileNativeChatLaunchDraftSeeds.set(key, null)
    const operation = harness.read().actions.handleCloseSessionTab({
      type: 'terminal',
      id: 'uncertain',
      title: 'Uncertain',
      isActive: false,
      terminal: 'term'
    })
    await harness.acknowledge('uncertain', operation, true, result)
    expect(destination.active).toBe(true)
    expect(readMobileNativeChatDraftInputs(key)).toBe(inputs)
    expect(readMobileNativeChatDraftEditGeneration(key)).toBe(1)
    expect(mobileNativeChatLaunchDraftSeeds.has(key)).toBe(true)
    if (kind.startsWith('refused')) {
      expect(harness.tabTombstones.has('uncertain')).toBe(false)
      expect(harness.setSessionTabs).not.toHaveBeenCalled()
    }
  })

  it.each(['closed', 'survivor-active', 'newer-selection'] as const)(
    'removes the listed native row on an unconfirmed close, retaining draft and %s selection safety',
    async (selection) => {
      const harness = await mount()
      const refs = harness.tabSelection
      const closed: MobileSessionTab = {
        type: 'agent-session',
        id: 'uncertain',
        sessionId: 'native-session',
        agent: 'codex',
        title: 'Uncertain',
        isActive: true
      }
      const survivor: MobileSessionTab = {
        ...closed,
        id: 'survivor',
        sessionId: 'surviving-session',
        isActive: false
      }
      refs.sessionTabsRef.current = [closed, survivor]
      refs.activeSessionTabIdRef.current = closed.id
      refs.selectedSessionTabIdRef.current = closed.id
      refs.pendingSelectionRef.current = { kind: 'tab', tabId: closed.id }
      const key = 'host\0workspace\0uncertain'
      const destination = mobileNativeChatDraftDestination(key)
      updateMobileNativeChatDraftInputs(destination, (current) => ({ ...current, pending: 1 }))
      const inputs = readMobileNativeChatDraftInputs(key)
      setMobileNativeChatDraftText(key, 'keep this draft')
      mobileNativeChatLaunchDraftSeeds.set(key, { text: 'owned seed', createdAt: 1 })
      const operation = harness.read().actions.handleCloseSessionTab(closed)
      expect(harness.requests).toHaveBeenCalledExactlyOnceWith('session.tabs.close', {
        worktree: 'id:workspace',
        tabId: closed.id,
        reason: 'user'
      })
      if (selection !== 'closed') {
        refs.activeSessionTabIdRef.current = survivor.id
      }
      if (selection === 'newer-selection') {
        refs.selectedSessionTabIdRef.current = survivor.id
        refs.pendingSelectionRef.current = { kind: 'tab', tabId: survivor.id }
      }
      // Refused-journal runtime closes the presentation without confirming durable retirement.
      await harness.acknowledge(closed.id, operation, true, { closed: true })
      expect(refs.sessionTabsRef.current).toEqual([survivor])
      expect(harness.setSessionTabs).toHaveBeenCalledExactlyOnceWith([survivor])
      expect(harness.tabTombstones.has(closed.id)).toBe(true)
      expect(refs.activeSessionTabIdRef.current).toBe(selection === 'closed' ? null : survivor.id)
      expect(refs.selectedSessionTabIdRef.current).toBe(selection === 'closed' ? null : survivor.id)
      expect(refs.pendingSelectionRef.current).toEqual(
        selection === 'newer-selection' ? { kind: 'tab', tabId: survivor.id } : null
      )
      if (selection === 'closed') {
        expect(harness.setActiveSessionTabId).toHaveBeenCalledExactlyOnceWith(null)
      } else {
        expect(harness.setActiveSessionTabId).not.toHaveBeenCalled()
      }
      expect(destination.active).toBe(true)
      expect(readMobileNativeChatDraftInputs(key)).toBe(inputs)
      expect(readMobileNativeChatDraftEditGeneration(key)).toBe(1)
      expect(mobileNativeChatLaunchDraftSeeds.get(key)).toEqual({
        text: 'owned seed',
        createdAt: 1
      })
    }
  )

  it('retires uploads handed back from a queued editor when their destination tab closes', async () => {
    const harness = await mount()
    const destination = mobileNativeChatDraftDestination('queued-editor')
    const scope = 'host\0workspace\0closed'
    closeMobileNativeChatEditInputs('queued-editor', scope)
    expect(destination.active).toBe(true)
    expect(destination.scope).toBe(scope)
    const operation = harness.read().actions.handleCloseSessionTab({
      type: 'terminal',
      id: 'closed',
      title: 'Closed',
      isActive: false,
      terminal: 'closed'
    })
    await harness.acknowledge('closed', operation)
    expect(destination.active).toBe(false)
    updateMobileNativeChatDraftInputs(destination, (current) => ({ ...current, pending: 1 }))
    expect(readMobileNativeChatDraftInputs(scope).pending).toBeUndefined()
  })
})
