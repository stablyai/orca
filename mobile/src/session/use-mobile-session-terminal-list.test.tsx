import { act } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hookMount } from '../test-support/rpc-recording/hook-mount'
import { mountFixture } from '../test-support/rpc-recording/recorder-fixture-shape'
import type { RpcResponse } from '../transport/types'
import { useMobileSessionTerminalList } from './use-mobile-session-terminal-list'
import { useMobileSessionTabTitles } from './use-mobile-session-tab-titles'
import type { TerminalRecord } from './mobile-terminal-records'
import type { MobileSessionTab } from './mobile-session-route-types'

function reply(title = 'Saved task name', worktreeId = 'workspace-1'): RpcResponse {
  const pane = { type: 'terminal', handle: 'cursor-1', tabId: 'tab-1', leafId: 'leaf-1' }
  return {
    id: 'reply-1',
    ok: true,
    _meta: { runtimeId: 'runtime-1' },
    result: {
      terminals: [{ ...pane, title: '⠋ Cursor Agent', agentIdentity: 'cursor' }],
      visualLayouts: [
        {
          worktreeId,
          root: {
            type: 'group',
            tabs: [{ tabId: 'tab-1', title, panes: pane }]
          }
        }
      ]
    }
  }
}

describe('terminal inventory saved tab names', () => {
  let dispose: (() => void) | undefined
  afterEach(() => dispose?.())

  function mount(sendRequest: (method: string, params: unknown) => Promise<RpcResponse>) {
    let worktreeId = 'workspace-1'
    let hostId = 'host-1'
    let list: ReturnType<typeof useMobileSessionTerminalList>
    let labels: ReadonlyMap<string, string> = new Map()
    const tabs: MobileSessionTab[] = [
      {
        type: 'terminal',
        id: 'tab-1',
        parentTabId: 'tab-1',
        leafId: 'leaf-1',
        terminal: 'cursor-1',
        title: '⠋ Cursor Agent',
        isActive: true
      }
    ]
    const terminalsRef: { current: TerminalRecord[] } = { current: [] }
    const client = { sendRequest }
    const setSessionTabs = vi.fn()
    const hook = hookMount(() => {
      list = useMobileSessionTerminalList(
        mountFixture<Parameters<typeof useMobileSessionTerminalList>[0]>({
          hostId,
          worktreeId,
          client,
          terminalsRef,
          sessionTabsRef: { current: tabs },
          setSessionTabs,
          setTerminals: () => {},
          pruneTerminalHandlesFromLiveInput: () => {},
          defaultTerminalHandlesToLiveInput: () => {},
          clearTerminalLiveInputDefault: () => {},
          setTerminalKeyboardMetrics: () => {},
          terminalRefs: { current: new Map() },
          terminalUnsubsRef: { current: new Map() },
          viewportResubscribeBudgetRef: {
            current: { forget: () => {}, notifyListedHandles: () => {} }
          },
          activeHandleRef: { current: 'cursor-1' },
          showNativeChatRef: { current: false },
          unsubscribeTerminal: () => {},
          nativeChatStream: { notifyListedHandles: () => {} },
          bufferedTerminalDraftState: { pruneDrafts: () => {} }
        })
      )
      labels = useMobileSessionTabTitles(
        tabs,
        JSON.stringify([hostId, worktreeId]),
        list.desktopTabTitles
      )
    })
    hook.mount()
    dispose = hook.unmount
    return {
      startRefresh() {
        let pending: Promise<boolean> | undefined
        act(() => {
          pending = list.fetchTerminals()
        })
        return pending
      },
      async refresh() {
        await act(async () => {
          await list.fetchTerminals()
        })
      },
      changeScope(nextHost: string, nextWorktree: string) {
        hostId = nextHost
        worktreeId = nextWorktree
        hook.update()
      },
      title: () => labels.get('tab-1'),
      saved: () => list.desktopTabTitles,
      setSessionTabs
    }
  }

  it('uses the existing list request to recover and refresh names without changing tab order', async () => {
    let current = reply()
    const request = vi.fn(async () => current)
    const screen = mount(request)
    expect(screen.title()).toBe('Cursor Agent')
    await screen.refresh()
    expect(request).toHaveBeenCalledWith('terminal.list', {
      worktree: 'id:workspace-1',
      includeVisualLayouts: true
    })
    expect(screen.title()).toBe('Saved task name')
    current = reply('Renamed by the user')
    await screen.refresh()
    expect(screen.title()).toBe('Renamed by the user')
    expect(screen.setSessionTabs).not.toHaveBeenCalled()
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('hides names immediately on a host or workspace change and ignores late old replies', async () => {
    const request = vi.fn(async () => reply())
    const screen = mount(request)
    await screen.refresh()
    let finish: ((value: RpcResponse) => void) | undefined
    request.mockImplementationOnce(
      () =>
        new Promise<RpcResponse>((resolve) => {
          finish = resolve
        })
    )
    const pending = screen.startRefresh()
    await act(async () => {
      await Promise.resolve()
    })
    screen.changeScope('host-2', 'workspace-2')
    expect(screen.saved()).toBeUndefined()
    expect(screen.title()).toBe('Cursor Agent')
    await act(async () => {
      finish?.(reply('Stale old-scope name'))
      await pending
    })
    expect(screen.saved()).toBeUndefined()
    request.mockResolvedValueOnce(reply('New host name', 'workspace-2'))
    await screen.refresh()
    expect(screen.title()).toBe('New host name')
  })

  it('keeps older hosts without layouts working', async () => {
    const screen = mount(async () => ({
      id: 'old-reply',
      ok: true,
      _meta: { runtimeId: 'old-runtime' },
      result: { terminals: [{ handle: 'cursor-1', title: 'Cursor Agent' }] }
    }))
    await screen.refresh()
    expect(screen.title()).toBe('Cursor Agent')
    expect(screen.saved()?.size).toBe(0)
  })
})
