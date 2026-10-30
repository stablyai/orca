import { createElement, useRef, useState } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import type { RpcResponse } from '../transport/types'
import type { MobileSessionContentCreateActionsModel } from './use-mobile-session-content-create-actions'
import type { Terminal } from './mobile-session-route-types'
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
      const pendingSelectionRef = useRef<PendingSessionSelection | null>(null)
      const scope = {
        hostId: 'host',
        worktreeId: 'workspace',
        client,
        terminals,
        setTerminals,
        terminalsRef,
        activeHandleRef,
        setActiveHandle,
        pendingSelectionRef,
        setSessionTabs,
        setFileDocs: vi.fn(),
        setMarkdownDocs: vi.fn(),
        sessionTabsRef: { current: [] },
        reconcileBufferedDraftsRef: { current: vi.fn() },
        closedTabTombstonesRef: { current: tabTombstones },
        clearTerminalLiveInputDefault: vi.fn(),
        setActiveSessionTabId: vi.fn(),
        activeSessionTabIdRef: { current: null },
        selectedSessionTabIdRef: { current: null },
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
    ['delegated', { closed: true }],
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
