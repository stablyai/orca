import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import type { RpcResponse } from '../transport/types'
import { mountFixture } from '../test-support/rpc-recording/recorder-fixture-shape'
import type { MobileSessionTab } from './mobile-session-route-types'
import { useMobileSessionBulkClose } from './use-mobile-session-bulk-close'

describe('pending terminal activation', () => {
  let renderer: ReactTestRenderer | null = null
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('drops a reply that lands after the route moved to another workspace', async () => {
    const client = new FakeSession('connected')
    const replies: ((reply: RpcResponse) => void)[] = []
    client.sendRequest.mockImplementation(
      () => new Promise<RpcResponse>((resolve) => replies.push(resolve))
    )
    const applied: unknown[] = []
    const attemptRef: { current: string | null } = { current: null }
    const pendingTab = (id: string) =>
      mountFixture<Extract<MobileSessionTab, { type: 'terminal' }>>({
        id,
        type: 'terminal',
        title: id,
        terminal: null
      })
    let route = { worktreeId: 'wt-1', tab: pendingTab('tab-1') }

    function Harness() {
      useMobileSessionBulkClose(
        mountFixture<Parameters<typeof useMobileSessionBulkClose>[0]>({
          worktreeId: route.worktreeId,
          client,
          connState: 'connected',
          sessionTabs: [route.tab],
          sessionTabsRef: { current: [route.tab] },
          activeSessionTabIdRef: { current: route.tab.id },
          markdownDocs: new Map(),
          pendingTerminalActivationAttemptRef: attemptRef,
          activeSessionTab: route.tab,
          scheduleDelayedAction: () => {},
          applySessionTabs: (result) => {
            applied.push(result)
            return { accepted: true, effectiveTabs: [] }
          },
          fetchSessionTabs: () => Promise.resolve(),
          switchSessionTab: () => {},
          handleCloseSessionTab: () => Promise.resolve(),
          pendingTerminalRecoveryContextKey: null,
          parkedPendingTerminalContext: null,
          retryPendingTerminalRecovery: () => Promise.resolve()
        })
      )
      return null
    }

    await act(async () => {
      renderer = create(createElement(Harness))
    })
    expect(replies).toHaveLength(1)

    // A reused route resets the attempt (the startup hook's route reset) and opens the next workspace.
    attemptRef.current = null
    route = { worktreeId: 'wt-2', tab: pendingTab('tab-2') }
    await act(async () => {
      renderer?.update(createElement(Harness))
    })

    await act(async () => {
      replies[0]({
        id: 'rpc-1',
        ok: true,
        result: { worktree: 'wt-1', tabs: [] },
        _meta: { runtimeId: 'runtime-1' }
      })
    })
    expect(applied).toEqual([])
  })
})
