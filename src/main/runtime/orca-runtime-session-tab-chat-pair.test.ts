import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  HEADLESS_SECOND_LEAF_ID,
  TEST_WORKTREE_ID,
  makeDeferred,
  makeHeadlessTerminalLayout,
  makeRpcRequest,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from './orca-runtime-test-fixtures.spec'
import { RpcDispatcher } from './rpc/dispatcher'
import { normalizeWorkspaceSessionPaneIdentities } from '../persistence/restoring-sessions/workspace-pane-normalization'
import { SESSION_TAB_METHODS } from './rpc/methods/session-tabs'
import type { RuntimeStore } from './runtime-store-contract'
import type { Tab } from '../../shared/tab-types'
import type { TerminalLayoutSnapshot } from '../../shared/terminal-tab-types'
import type { RuntimeSessionTabPropsResult } from '../../shared/runtime-session-contracts'

const A = HEADLESS_LEAF_ID
const B = HEADLESS_SECOND_LEAF_ID
const SURFACE_A = `host-tab::${A}`
const SURFACE_B = `host-tab::${B}`

const UNIFIED_HOST_TAB: Tab = {
  id: 'host-tab',
  entityId: 'host-tab',
  groupId: 'group-1',
  worktreeId: TEST_WORKTREE_ID,
  contentType: 'terminal',
  label: 'Persisted Terminal',
  customLabel: null,
  color: null,
  sortOrder: 0,
  createdAt: 1
}

function makeChatPairHost(
  options: {
    viewMode?: 'terminal' | 'chat'
    chatLeafId?: string
    layout?: boolean
    normalizeOnWrite?: boolean
  } = {}
) {
  const layout: TerminalLayoutSnapshot = {
    ...makeHeadlessTerminalLayout({ [A]: 'persisted-pty', [B]: undefined }),
    ...(options.chatLeafId ? { chatLeafId: options.chatLeafId } : {})
  }
  const base = makeWorkspaceSessionWithHeadlessTerminal()
  const terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot> =
    options.layout === false ? {} : { 'host-tab': layout }
  const session = {
    ...base,
    unifiedTabs: {
      [TEST_WORKTREE_ID]: [
        { ...UNIFIED_HOST_TAB, ...(options.viewMode ? { viewMode: options.viewMode } : {}) }
      ]
    },
    terminalLayoutsByTabId
  }
  const { runtimeStore, getSession, setSession } = makeRuntimeStoreWithWorkspaceSession(session)
  if (options.normalizeOnWrite) {
    // Production persistence normalizes pane identities, which strips an owner outside the tree.
    runtimeStore.setWorkspaceSession.mockImplementation((next) =>
      setSession(
        normalizeWorkspaceSessionPaneIdentities(next, getSession().terminalLayoutsByTabId).session
      )
    )
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The shared fixture implements RuntimeStore; its annotation erases the Vitest mock call signatures.
  const store = runtimeStore as RuntimeStore
  const runtime = new OrcaRuntimeService(store)
  const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
  const write = async (
    tabId: string,
    viewMode: 'terminal' | 'chat',
    chatViewWrite?: { writerId: string; seq: number },
    connectionId = 'connection-1'
  ): Promise<RuntimeSessionTabPropsResult> => {
    const response = await dispatcher.dispatch(
      makeRpcRequest('session.tabs.setTabProps', {
        worktree: `id:${TEST_WORKTREE_ID}`,
        tabId,
        viewMode,
        ...(chatViewWrite ? { chatViewWrite } : {})
      }),
      { clientKind: 'mobile', pairedDeviceId: 'phone', connectionId }
    )
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: setTabProps's handler returns RuntimeSessionTabPropsResult.
    return response.result as RuntimeSessionTabPropsResult
  }
  const hostPair = () => {
    const current = getSession()
    return {
      row: current.tabsByWorktree[TEST_WORKTREE_ID]?.[0]?.viewMode,
      unified: current.unifiedTabs?.[TEST_WORKTREE_ID]?.[0]?.viewMode,
      owner: current.terminalLayoutsByTabId['host-tab']?.chatLeafId
    }
  }
  const publishedPairs = async () =>
    (await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs.flatMap((tab) =>
      tab.type === 'terminal'
        ? [{ viewMode: tab.viewMode, owner: tab.parentLayout?.chatLeafId }]
        : []
    )
  return { runtime, store, getSession, write, hostPair, publishedPairs }
}

describe('session.tabs.setTabProps chat pair writer (headless host)', () => {
  it('writes the whole pair absolutely in one session write and one snapshot', async () => {
    const host = makeChatPairHost()
    await host.publishedPairs()
    const writes = vi.mocked(host.store.setWorkspaceSession!).mock.calls.length
    const version =
      host.runtime['mobileSessionTabsByWorktree'].get(TEST_WORKTREE_ID)!.snapshotVersion

    const reply = await host.write(SURFACE_B, 'chat')

    expect(reply).toEqual({ updated: true, chatView: { viewMode: 'chat', chatLeafId: B } })
    expect(vi.mocked(host.store.setWorkspaceSession!).mock.calls.length).toBe(writes + 1)
    expect(host.runtime['mobileSessionTabsByWorktree'].get(TEST_WORKTREE_ID)!.snapshotVersion).toBe(
      version + 1
    )
    expect(host.hostPair()).toEqual({ row: 'chat', unified: 'chat', owner: B })
    expect(
      (await host.runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).chatViewHostOwned
    ).toBe(true)
    expect(await host.publishedPairs()).toEqual([
      { viewMode: 'chat', owner: B },
      { viewMode: 'chat', owner: B }
    ])
  })

  it('keeps a valid owner for a parent-addressed chat, clears it on terminal, ignores unknown leaves', async () => {
    const host = makeChatPairHost({ viewMode: 'chat', chatLeafId: A })

    expect((await host.write('host-tab', 'chat')).chatView).toEqual({
      viewMode: 'chat',
      chatLeafId: A
    })
    expect((await host.write('host-tab', 'terminal')).chatView).toEqual({
      viewMode: 'terminal',
      chatLeafId: null
    })
    expect(host.hostPair()).toEqual({ row: 'terminal', unified: 'terminal', owner: undefined })
    // A surface id the snapshot does not list resolves to no leaf: nothing changes.
    const unknown = await host.runtime.setMobileSessionTabProps(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'host-tab::not-a-leaf',
      viewMode: 'terminal'
    })
    expect(unknown.chatView).toEqual({ viewMode: 'terminal', chatLeafId: null })
  })

  it('gives a tab with no layout chat on its sole derived pane without an owner id', async () => {
    const host = makeChatPairHost({ layout: false })
    const [surface] = (await host.runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs
    const reply = await host.write(surface!.id, 'chat')
    expect(reply.chatView).toEqual({ viewMode: 'chat', chatLeafId: null })
    expect(host.hostPair()).toEqual({ row: 'chat', unified: 'chat', owner: undefined })
  })
})

describe('session.tabs.setTabProps writer fence', () => {
  it('refuses an older write held in the visibility await after a newer one applied', async () => {
    const host = makeChatPairHost()
    await host.publishedPairs()
    const held = makeDeferred()
    const list = host.runtime.listMobileSessionTabs.bind(host.runtime)
    vi.spyOn(host.runtime, 'listMobileSessionTabs').mockImplementationOnce(async (...args) => {
      await held.promise
      return list(...args)
    })
    const s1 = host.write(SURFACE_A, 'chat', { writerId: 'W', seq: 1 })
    const s2 = await host.write(SURFACE_A, 'terminal', { writerId: 'W', seq: 2 }, 'connection-2')
    expect(s2).toEqual({ updated: true, chatView: { viewMode: 'terminal', chatLeafId: null } })
    const version =
      host.runtime['mobileSessionTabsByWorktree'].get(TEST_WORKTREE_ID)!.snapshotVersion

    held.resolve()
    expect(await s1).toEqual({
      updated: true,
      chatView: { viewMode: 'terminal', chatLeafId: null },
      superseded: true
    })
    expect(host.hostPair()).toEqual({ row: 'terminal', unified: 'terminal', owner: undefined })
    // The refused write published nothing.
    expect(host.runtime['mobileSessionTabsByWorktree'].get(TEST_WORKTREE_ID)!.snapshotVersion).toBe(
      version
    )
  })

  it('refuses the older write even when its client already timed out and never reconnected', async () => {
    const host = makeChatPairHost()
    await host.publishedPairs()
    const held = makeDeferred()
    const list = host.runtime.listMobileSessionTabs.bind(host.runtime)
    vi.spyOn(host.runtime, 'listMobileSessionTabs').mockImplementationOnce(async (...args) => {
      await held.promise
      return list(...args)
    })
    // The client stops waiting for s1; the host still runs it.
    const abandoned = host.write(SURFACE_A, 'chat', { writerId: 'W', seq: 1 })
    await host.write(SURFACE_A, 'terminal', { writerId: 'W', seq: 2 })
    held.resolve()
    await abandoned
    expect(host.hostPair().owner).toBeUndefined()
    expect(await host.publishedPairs()).toEqual([
      { viewMode: 'terminal', owner: undefined },
      { viewMode: 'terminal', owner: undefined }
    ])
  })

  it('answers a resend of the same sequence with the current pair and no write', async () => {
    const host = makeChatPairHost()
    await host.write(SURFACE_B, 'chat', { writerId: 'W', seq: 2 })
    const writes = vi.mocked(host.store.setWorkspaceSession!).mock.calls.length

    const resend = await host.write(SURFACE_B, 'chat', { writerId: 'W', seq: 2 })

    expect(resend).toEqual({ updated: true, chatView: { viewMode: 'chat', chatLeafId: B } })
    expect(vi.mocked(host.store.setWorkspaceSession!).mock.calls.length).toBe(writes)
  })

  it('orders each writer independently: between writers the last arrival wins', async () => {
    const host = makeChatPairHost()
    await host.write(SURFACE_A, 'chat', { writerId: 'W', seq: 5 })
    await host.write(SURFACE_B, 'chat', { writerId: 'X', seq: 1 })
    expect(host.hostPair().owner).toBe(B)
    await host.write(SURFACE_A, 'terminal', { writerId: 'W', seq: 6 })
    expect(host.hostPair()).toEqual({ row: 'terminal', unified: 'terminal', owner: undefined })
    expect((await host.write(SURFACE_B, 'chat', { writerId: 'X', seq: 2 })).chatView).toEqual({
      viewMode: 'chat',
      chatLeafId: B
    })
  })

  it('leaves writes without chatViewWrite unfenced', async () => {
    const host = makeChatPairHost()
    await host.write(SURFACE_A, 'chat', { writerId: 'W', seq: 9 })
    expect((await host.write(SURFACE_B, 'chat')).chatView).toEqual({
      viewMode: 'chat',
      chatLeafId: B
    })
  })

  it('refuses a frame delayed on an old connection after twenty other writers churn the tab', async () => {
    const host = makeChatPairHost()
    // s1 was written on connection 1 but has not reached the host yet.
    const s2 = await host.write(SURFACE_A, 'terminal', { writerId: 'W', seq: 2 }, 'connection-2')
    expect(s2.chatView).toEqual({ viewMode: 'terminal', chatLeafId: null })
    for (let index = 0; index < 20; index += 1) {
      await host.write(SURFACE_B, 'terminal', { writerId: `churn-${index}`, seq: 1 })
    }

    const late = await host.write(SURFACE_A, 'chat', { writerId: 'W', seq: 1 }, 'connection-1')

    expect(late).toEqual({
      updated: true,
      chatView: { viewMode: 'terminal', chatLeafId: null },
      superseded: true
    })
    expect(host.hostPair()).toEqual({ row: 'terminal', unified: 'terminal', owner: undefined })
    expect(await host.publishedPairs()).toEqual([
      { viewMode: 'terminal', owner: undefined },
      { viewMode: 'terminal', owner: undefined }
    ])
  })
})

describe('session.tabs.setTabProps writer fence on a desktop-owned host', () => {
  it('relays in admit order and never relays a superseded write', async () => {
    const host = makeChatPairHost()
    await host.publishedPairs()
    const relayed: string[] = []
    // A renderer owns the tab: writes go through the relay rather than persistence.
    Reflect.set(host.runtime, 'getAvailableAuthoritativeWindow', () => ({}))
    Reflect.set(host.runtime, 'notifier', {
      setTerminalChatView: vi.fn(
        async (_worktreeId: string, tabId: string, leafId: string | null, viewMode: string) => {
          relayed.push(`${tabId}:${leafId}:${viewMode}`)
          return { viewMode, chatLeafId: viewMode === 'chat' ? leafId : null }
        }
      )
    })
    const held = makeDeferred()
    const list = host.runtime.listMobileSessionTabs.bind(host.runtime)
    vi.spyOn(host.runtime, 'listMobileSessionTabs').mockImplementationOnce(async (...args) => {
      await held.promise
      return list(...args)
    })
    const s1 = host.write(SURFACE_A, 'chat', { writerId: 'W', seq: 1 })
    const s2 = await host.write(SURFACE_B, 'chat', { writerId: 'W', seq: 2 })
    held.resolve()

    expect(s2.chatView).toEqual({ viewMode: 'chat', chatLeafId: B })
    expect((await s1).superseded).toBe(true)
    expect(relayed).toEqual([`host-tab:${B}:chat`])
  })

  it("leaves the desktop's view alone for an unfenced write, as today's paired clients send", async () => {
    const host = makeChatPairHost()
    await host.publishedPairs()
    const setTerminalChatView = vi.fn()
    Reflect.set(host.runtime, 'getAvailableAuthoritativeWindow', () => ({}))
    Reflect.set(host.runtime, 'notifier', { setTerminalChatView })

    expect(await host.write(SURFACE_A, 'terminal')).toEqual({ updated: true })
    expect(setTerminalChatView).not.toHaveBeenCalled()
  })

  it('relays a resend of the same sequence again while the first relay is still pending', async () => {
    const host = makeChatPairHost()
    await host.publishedPairs()
    const firstRelay = makeDeferred()
    const setTerminalChatView = vi
      .fn()
      .mockReturnValueOnce(firstRelay.promise.then(() => ({ viewMode: 'chat', chatLeafId: A })))
      .mockResolvedValueOnce({ viewMode: 'chat', chatLeafId: A })
    Reflect.set(host.runtime, 'getAvailableAuthoritativeWindow', () => ({}))
    Reflect.set(host.runtime, 'notifier', { setTerminalChatView })

    const first = host.write(SURFACE_A, 'chat', { writerId: 'W', seq: 1 })
    const resend = await host.write(SURFACE_A, 'chat', { writerId: 'W', seq: 1 })
    firstRelay.resolve()
    await first

    expect(setTerminalChatView).toHaveBeenCalledTimes(2)
    expect(resend.chatView).toEqual({ viewMode: 'chat', chatLeafId: A })
    expect((await host.write(SURFACE_A, 'chat', { writerId: 'W', seq: 1 })).superseded).toBe(
      undefined
    )
    expect(setTerminalChatView).toHaveBeenCalledTimes(2)
  })

  it('applies a resend of the same sequence after its relay failed', async () => {
    const host = makeChatPairHost()
    await host.publishedPairs()
    const setTerminalChatView = vi
      .fn()
      .mockRejectedValueOnce(new Error('chat_view_relay_timeout'))
      .mockResolvedValueOnce({ viewMode: 'chat', chatLeafId: A })
    Reflect.set(host.runtime, 'getAvailableAuthoritativeWindow', () => ({}))
    Reflect.set(host.runtime, 'notifier', { setTerminalChatView })

    await expect(host.write(SURFACE_A, 'chat', { writerId: 'W', seq: 1 })).rejects.toThrow(
      'chat_view_relay_timeout'
    )
    const resend = await host.write(SURFACE_A, 'chat', { writerId: 'W', seq: 1 })

    expect(setTerminalChatView).toHaveBeenCalledTimes(2)
    expect(resend.chatView).toEqual({ viewMode: 'chat', chatLeafId: A })
  })
})

describe('writer fence lifetime', () => {
  it('keeps marks while a sibling pane survives and drops them when the tab closes', async () => {
    const host = makeChatPairHost()
    await host.write(SURFACE_A, 'chat', { writerId: 'W', seq: 4 })
    const fence = host.runtime['chatViewWriteFence']

    await host.runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, SURFACE_B)
    expect(fence.admit(TEST_WORKTREE_ID, 'host-tab', 'W', 3)).toBe('superseded')

    await host.runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab')
    expect(fence.admit(TEST_WORKTREE_ID, 'host-tab', 'W', 3)).toBe('apply')
  })

  it('drops marks when the desktop closes a tab it owns', () => {
    const runtime = new OrcaRuntimeService()
    runtime.attachWindow(1)
    const publish = (snapshotVersion: number, withTab: boolean) =>
      runtime.syncWindowGraph(1, {
        tabs: [],
        leaves: [],
        mobileSessionTabs: [
          {
            worktree: 'repo::/worktree',
            publicationEpoch: 'renderer-epoch',
            snapshotVersion,
            activeGroupId: null,
            activeTabId: null,
            activeTabType: null,
            tabs: withTab
              ? [
                  {
                    type: 'terminal',
                    id: `desk-tab::${A}`,
                    parentTabId: 'desk-tab',
                    leafId: A,
                    title: 'Terminal 1',
                    isActive: true
                  }
                ]
              : []
          }
        ]
      })
    publish(1, true)
    const fence = runtime['chatViewWriteFence']
    fence.admit('repo::/worktree', 'desk-tab', 'W', 4)

    publish(2, true)
    expect(fence.admit('repo::/worktree', 'desk-tab', 'W', 3)).toBe('superseded')
    publish(3, false)
    expect(fence.admit('repo::/worktree', 'desk-tab', 'W', 3)).toBe('apply')
  })

  it('drops every mark of a removed worktree', async () => {
    const host = makeChatPairHost()
    await host.write(SURFACE_A, 'chat', { writerId: 'W', seq: 4 })
    const fence = host.runtime['chatViewWriteFence']

    host.runtime['removeWorktreeMetadataAndHistory'](host.store, TEST_WORKTREE_ID)

    expect(fence.admit(TEST_WORKTREE_ID, 'host-tab', 'W', 3)).toBe('apply')
  })
})

describe('closing the chat-owning pane on a headless host', () => {
  it('turns the tab to terminal in the immediate snapshot, in persistence and after a restart', async () => {
    const host = makeChatPairHost({ viewMode: 'chat', chatLeafId: A })

    await host.runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, SURFACE_A)

    expect(host.hostPair()).toEqual({ row: 'terminal', unified: 'terminal', owner: undefined })
    expect(await host.publishedPairs()).toEqual([{ viewMode: 'terminal', owner: undefined }])
    host.runtime['mobileSessionTabsByWorktree'].delete(TEST_WORKTREE_ID)
    host.runtime['hydrateHeadlessMobileSessionTabsFromWorkspaceSession'](TEST_WORKTREE_ID)
    expect(await host.publishedPairs()).toEqual([{ viewMode: 'terminal', owner: undefined }])
  })

  it('keeps chat when a non-owning pane closes', async () => {
    const host = makeChatPairHost({ viewMode: 'chat', chatLeafId: A })

    await host.runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, SURFACE_B)

    expect(host.hostPair()).toEqual({ row: undefined, unified: 'chat', owner: A })
    expect(await host.publishedPairs()).toEqual([{ viewMode: 'chat', owner: A }])
  })

  it.each([false, true])(
    'turns the tab to terminal when an accepted layout push no longer holds the owner (normalizing store: %s)',
    async (normalizeOnWrite) => {
      const host = makeChatPairHost({ viewMode: 'chat', chatLeafId: A, normalizeOnWrite })
      await host.publishedPairs()
      const frames: string[] = []
      host.runtime.onMobileSessionTabsChanged((frame) => {
        for (const tab of frame.tabs) {
          if (tab.type === 'terminal') {
            frames.push(`${tab.viewMode}:${tab.parentLayout?.chatLeafId ?? 'none'}`)
          }
        }
      }, 'observer')

      await host.runtime.updateMobileSessionPaneLayout(`id:${TEST_WORKTREE_ID}`, {
        tabId: 'host-tab',
        root: { type: 'leaf', leafId: B },
        expandedLeafId: null,
        chatLeafId: B
      })

      expect(host.hostPair()).toEqual({ row: 'terminal', unified: 'terminal', owner: undefined })
      expect((await host.publishedPairs()).every((pair) => pair.viewMode === 'terminal')).toBe(true)
      // No frame in between may show chat without its owning pane.
      expect(frames.length).toBeGreaterThan(0)
      expect(frames.filter((frame) => frame.startsWith('chat'))).toEqual([])
    }
  )
})
