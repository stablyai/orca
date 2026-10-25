import { createElement, useRef, useState } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import type { RpcResponse } from '../transport/types'
import type { MobileSessionContentCreateActionsModel } from './use-mobile-session-content-create-actions'
import type { Terminal } from './mobile-session-route-types'
import type { PendingSessionSelection } from './pending-session-selection'
import { useMobileSessionCloseActions } from './use-mobile-session-close-actions'

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
          }
        })
    )
    const subscribe = vi.fn()
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
        worktreeId: 'workspace',
        client,
        terminals,
        setTerminals,
        terminalsRef,
        activeHandleRef,
        setActiveHandle,
        pendingSelectionRef,
        setSessionTabs: vi.fn(),
        setFileDocs: vi.fn(),
        setMarkdownDocs: vi.fn(),
        sessionTabsRef: { current: [] },
        reconcileBufferedDraftsRef: { current: vi.fn() },
        closedTabTombstonesRef: { current: new Map() },
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
      requests: client.sendRequest,
      async acknowledge(handle: string, operation: Promise<void>) {
        await act(async () => {
          const resolve = acknowledgments.get(handle)
          if (!resolve) {
            throw new Error(`Missing close for ${handle}`)
          }
          resolve({ id: `close-${handle}`, ok: true, result: {} })
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
})
