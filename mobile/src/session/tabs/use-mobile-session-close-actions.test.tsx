import { createElement, useRef, useState, type SetStateAction } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { documentQueryClient } from '../../test-support/rpc-recording/hook-mount'
import { FakeSession } from '../../transport/connection/mobile-endpoint-supervisor-test-fakes'
import type { RpcResponse } from '../../transport/rpc/rpc-wire-types'
import type { MobileSessionContentCreateActionsModel } from '../use-mobile-session-content-create-actions'
import type { Terminal } from '../../terminal/session/mobile-terminal-model'
import type { PendingSessionSelection } from './pending-session-selection'
import { useMobileSessionCloseActions } from './use-mobile-session-close-actions'
import {
  closeMobileNativeChatEditInputs,
  mobileNativeChatDraftDestination,
  readMobileNativeChatDraftInputs,
  updateMobileNativeChatDraftInputs
} from '../native-chat/composer/mobile-native-chat-draft-inputs'
import { closeMobileNativeChatTabDraft } from '../native-chat/composer/mobile-native-chat-draft-store'

import { loadMobileNativeChatDrafts } from '../native-chat/composer/mobile-native-chat-draft-persistence'

vi.mock('@react-native-async-storage/async-storage', async () => {
  const { createInMemoryAsyncStorage } = await import('../../test-support/in-memory-async-storage')
  return { default: createInMemoryAsyncStorage() }
})

const initial: Terminal[] = ['a', 'b', 'c'].map((handle) => ({
  handle,
  title: handle,
  isActive: handle === 'a'
}))

describe('legacy terminal close acknowledgments', () => {
  let renderer: ReactTestRenderer | null = null
  let queries: ReturnType<typeof documentQueryClient> | null = null
  afterEach(async () => {
    act(() => renderer?.unmount())
    renderer = null
    await queries?.end()
    queries = null
    await loadMobileNativeChatDrafts('host', 'workspace')
    closeMobileNativeChatTabDraft('queued-editor')
    closeMobileNativeChatTabDraft('host\0workspace\0closed')
    await loadMobileNativeChatDrafts('host', 'workspace')
  })

  async function mount(renameTarget: Terminal | null = null) {
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
    const setRenameTarget = vi.fn<(update: SetStateAction<Terminal | null>) => void>()
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
        forgetLastSessionTab: () => {},
        closedTabTombstonesRef: { current: tabTombstones },
        setActiveSessionTabId,
        renameTarget,
        setRenameTarget,
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
    queries = documentQueryClient()
    await act(async () => {
      renderer = create(queries!.wrap(createElement(Harness)))
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
      setRenameTarget,
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
