import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  HEADLESS_SECOND_LEAF_ID,
  TEST_WORKTREE_ID,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from './orca-runtime-test-fixtures.spec'
import type { RuntimeStore } from './runtime-store-contract'
import type { Tab } from '../../shared/tab-types'
import type { TerminalLayoutSnapshot } from '../../shared/terminal-tab-types'

const A = HEADLESS_LEAF_ID
const B = HEADLESS_SECOND_LEAF_ID

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

/**
 * A headless host tab. `agentOn` leaves get a PTY whose launch record names a supported agent,
 * `shellOn` a freshly spawned PTY known to run none, `inventoryOn` a PTY known only from inventory.
 */
function makeOwnerHost(options: {
  viewMode?: 'terminal' | 'chat'
  leaves: 0 | 1 | 2
  activeLeafId?: string
  agentOn?: string[]
  shellOn?: string[]
  inventoryOn?: string[]
  chatLeafId?: string
}) {
  const ptyIds: Record<string, string> = { [A]: 'pty-a', [B]: 'pty-b' }
  const layout: TerminalLayoutSnapshot = {
    ...makeHeadlessTerminalLayout(
      options.leaves === 2 ? { [A]: ptyIds[A], [B]: ptyIds[B] } : { [A]: ptyIds[A] }
    ),
    ...(options.leaves === 0 ? { root: null, ptyIdsByLeafId: {} } : {}),
    activeLeafId: options.activeLeafId ?? (options.leaves === 2 ? B : A),
    ...(options.chatLeafId ? { chatLeafId: options.chatLeafId } : {})
  }
  const base = makeWorkspaceSessionWithHeadlessTerminal()
  const session = {
    ...base,
    unifiedTabs: {
      [TEST_WORKTREE_ID]: [
        { ...UNIFIED_HOST_TAB, ...(options.viewMode ? { viewMode: options.viewMode } : {}) }
      ]
    },
    terminalLayoutsByTabId: { 'host-tab': layout }
  }
  const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The shared fixture implements RuntimeStore; its annotation erases the Vitest mock call signatures.
  const store = runtimeStore as RuntimeStore
  const runtime = new OrcaRuntimeService(store)
  for (const leafId of options.agentOn ?? []) {
    runtime.registerPty(ptyIds[leafId]!, TEST_WORKTREE_ID, null, {
      tabId: 'host-tab',
      leafId,
      incarnationId: `inc-${leafId}`,
      agentLaunchAuthority: { launchToken: `token-${leafId}`, launchAgent: 'claude' }
    })
  }
  for (const leafId of options.shellOn ?? []) {
    runtime.registerPty(ptyIds[leafId]!, TEST_WORKTREE_ID, null, {
      tabId: 'host-tab',
      leafId,
      incarnationId: `inc-${leafId}`,
      isReattach: false
    })
  }
  for (const leafId of options.inventoryOn ?? []) {
    runtime['recordPtyWorktree'](ptyIds[leafId]!, TEST_WORKTREE_ID, { connected: true })
  }
  const hostPair = () => ({
    viewMode: getSession().unifiedTabs?.[TEST_WORKTREE_ID]?.[0]?.viewMode,
    owner: getSession().terminalLayoutsByTabId['host-tab']?.chatLeafId
  })
  const publishedPairs = async () =>
    (await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs.flatMap((tab) =>
      tab.type === 'terminal'
        ? [{ viewMode: tab.viewMode, owner: tab.parentLayout?.chatLeafId }]
        : []
    )
  const snapshotVersion = () =>
    runtime['mobileSessionTabsByWorktree'].get(TEST_WORKTREE_ID)?.snapshotVersion
  const writeCount = () => vi.mocked(store.setWorkspaceSession!).mock.calls.length
  return { runtime, store, getSession, hostPair, publishedPairs, snapshotVersion, writeCount }
}

describe('F1: a parent-addressed chat on a split gets a host owner (headless)', () => {
  it('owns chat on the agent pane, not the active shell, in one write and one snapshot', async () => {
    const host = makeOwnerHost({ leaves: 2, activeLeafId: B, agentOn: [A] })
    await host.publishedPairs()
    const writes = host.writeCount()
    const version = host.snapshotVersion()!

    const reply = await host.runtime.setMobileSessionTabProps(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'host-tab',
      viewMode: 'chat'
    })

    expect(reply.chatView).toEqual({ viewMode: 'chat', chatLeafId: A })
    expect(host.hostPair()).toEqual({ viewMode: 'chat', owner: A })
    expect(host.writeCount()).toBe(writes + 1)
    expect(host.snapshotVersion()).toBe(version + 1)
    expect(await host.publishedPairs()).toEqual([
      { viewMode: 'chat', owner: A },
      { viewMode: 'chat', owner: A }
    ])
  })

  it('prefers the active pane when it runs an agent', async () => {
    const host = makeOwnerHost({ leaves: 2, activeLeafId: B, agentOn: [A, B] })
    const reply = await host.runtime.setMobileSessionTabProps(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'host-tab',
      viewMode: 'chat'
    })
    expect(reply.chatView).toEqual({ viewMode: 'chat', chatLeafId: B })
  })

  it('changes nothing when no pane of the split runs an agent', async () => {
    const host = makeOwnerHost({ leaves: 2, viewMode: 'terminal' })
    await host.publishedPairs()
    const writes = host.writeCount()
    const version = host.snapshotVersion()

    const reply = await host.runtime.setMobileSessionTabProps(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'host-tab',
      viewMode: 'chat'
    })

    expect(reply.chatView).toEqual({ viewMode: 'terminal', chatLeafId: null })
    expect(host.hostPair()).toEqual({ viewMode: 'terminal', owner: undefined })
    expect(host.writeCount()).toBe(writes)
    expect(host.snapshotVersion()).toBe(version)
  })

  it('takes a parent chat on a saved layout with no pane yet, as the relay does (R1A-3)', async () => {
    const host = makeOwnerHost({ leaves: 0, viewMode: 'terminal' })
    const reply = await host.runtime.setMobileSessionTabProps(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'host-tab',
      viewMode: 'chat'
    })
    expect(reply.chatView).toEqual({ viewMode: 'chat', chatLeafId: null })
    expect(host.hostPair()).toEqual({ viewMode: 'chat', owner: undefined })
  })

  it('does not let a reattach of the same process bring back an agent the host saw exit', async () => {
    const host = makeOwnerHost({ leaves: 2, viewMode: 'terminal', agentOn: [A], shellOn: [B] })
    host.runtime['retirePtyAgentLaunchAuthority']('pty-a')
    const reattach = (incarnationId: string) =>
      host.runtime.registerPty('pty-a', TEST_WORKTREE_ID, 'ssh-1', {
        tabId: 'host-tab',
        leafId: A,
        incarnationId,
        isReattach: true,
        providerReattachLaunchIdentity: { incarnationId, launchAgent: 'claude' }
      })
    const chatWrite = () =>
      host.runtime.setMobileSessionTabProps(`id:${TEST_WORKTREE_ID}`, {
        tabId: 'host-tab',
        viewMode: 'chat'
      })

    // The relay still reports the spawn-time agent for this process after a reconnect.
    reattach(`inc-${A}`)
    expect(host.runtime['ptysById'].get('pty-a')?.launchAgent).toBeNull()
    expect((await chatWrite()).chatView).toEqual({ viewMode: 'terminal', chatLeafId: null })

    // A new process under the same id is a new launch: its reported agent is admitted.
    reattach(`inc-${A}-next`)
    expect((await chatWrite()).chatView).toEqual({ viewMode: 'chat', chatLeafId: A })
  })

  it('lets a reattach of the same process report the agent a fresh spawn did not prove', async () => {
    // A spawn with no admitted launch authority settles "no agent"; a renderer reload then
    // reattaches the same process and the daemon reports the agent it was launched with.
    const host = makeOwnerHost({ leaves: 2, viewMode: 'terminal', shellOn: [A, B] })
    host.runtime.registerPty('pty-a', TEST_WORKTREE_ID, null, {
      tabId: 'host-tab',
      leafId: A,
      incarnationId: `inc-${A}`,
      isReattach: true,
      providerReattachLaunchIdentity: { incarnationId: `inc-${A}`, launchAgent: 'claude' }
    })
    expect(host.runtime['ptysById'].get('pty-a')?.launchAgent).toBe('claude')
    const reply = await host.runtime.setMobileSessionTabProps(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'host-tab',
      viewMode: 'chat'
    })
    expect(reply.chatView).toEqual({ viewMode: 'chat', chatLeafId: A })
  })

  it('admits the reported agent on the first reattach after a restart', async () => {
    const host = makeOwnerHost({ leaves: 2, viewMode: 'terminal', shellOn: [B] })
    host.runtime.registerPty('pty-a', TEST_WORKTREE_ID, 'ssh-1', {
      tabId: 'host-tab',
      leafId: A,
      incarnationId: 'inc-A',
      isReattach: true,
      providerReattachLaunchIdentity: { incarnationId: 'inc-A', launchAgent: 'claude' }
    })
    const reply = await host.runtime.setMobileSessionTabProps(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'host-tab',
      viewMode: 'chat'
    })
    expect(reply.chatView).toEqual({ viewMode: 'chat', chatLeafId: A })
  })

  it('gives a sole pane the owner id even without agent evidence', async () => {
    const host = makeOwnerHost({ leaves: 1 })
    const reply = await host.runtime.setMobileSessionTabProps(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'host-tab',
      viewMode: 'chat'
    })
    expect(reply.chatView).toEqual({ viewMode: 'chat', chatLeafId: A })
  })
})

describe('F1: an accepted layout push that grows an ownerless single-pane chat', () => {
  it('pins the pre-split pane, even when the push names the new pane', async () => {
    const host = makeOwnerHost({ leaves: 1, viewMode: 'chat' })
    await host.runtime.updateMobileSessionPaneLayout(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'host-tab',
      root: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: A },
        second: { type: 'leaf', leafId: B }
      },
      expandedLeafId: null,
      chatLeafId: B
    })
    expect(host.hostPair()).toEqual({ viewMode: 'chat', owner: A })
  })

  it('never pins a terminal tab or moves an existing owner', async () => {
    const grown = {
      type: 'split' as const,
      direction: 'vertical' as const,
      first: { type: 'leaf' as const, leafId: A },
      second: { type: 'leaf' as const, leafId: B }
    }
    const terminal = makeOwnerHost({ leaves: 1, viewMode: 'terminal' })
    await terminal.runtime.updateMobileSessionPaneLayout(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'host-tab',
      root: grown,
      expandedLeafId: null
    })
    expect(terminal.hostPair().owner).toBeUndefined()

    const owned = makeOwnerHost({ leaves: 2, viewMode: 'chat', chatLeafId: B })
    await owned.runtime.updateMobileSessionPaneLayout(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'host-tab',
      root: grown,
      expandedLeafId: null,
      chatLeafId: A
    })
    expect(owned.hostPair()).toEqual({ viewMode: 'chat', owner: B })
  })
})

describe('F1: hydration repairs an ownerless chat with two or more panes once', () => {
  it('stores the agent pane as owner and writes once', async () => {
    const host = makeOwnerHost({
      leaves: 2,
      viewMode: 'chat',
      activeLeafId: B,
      agentOn: [A],
      shellOn: [B]
    })
    const writes = host.writeCount()

    expect(await host.publishedPairs()).toEqual([
      { viewMode: 'chat', owner: A },
      { viewMode: 'chat', owner: A }
    ])
    expect(host.hostPair()).toEqual({ viewMode: 'chat', owner: A })
    expect(host.writeCount()).toBe(writes + 1)

    host.runtime['mobileSessionTabsByWorktree'].delete(TEST_WORKTREE_ID)
    host.runtime['hydrateHeadlessMobileSessionTabsFromWorkspaceSession'](TEST_WORKTREE_ID)
    expect(host.writeCount()).toBe(writes + 1)
  })

  it('turns the tab terminal when every pane is known to run no agent', async () => {
    const host = makeOwnerHost({ leaves: 2, viewMode: 'chat', shellOn: [A, B] })
    expect(await host.publishedPairs()).toEqual([
      { viewMode: 'terminal', owner: undefined },
      { viewMode: 'terminal', owner: undefined }
    ])
    expect(host.hostPair()).toEqual({ viewMode: 'terminal', owner: undefined })
  })

  it('leaves the record alone while any pane is unknown, then repairs it (R1-COLD)', async () => {
    // Cold start: no PTY record, inventory-only records, or a reattach that reported no agent.
    const reattachNoReport = makeOwnerHost({ leaves: 2, viewMode: 'chat', agentOn: [A] })
    reattachNoReport.runtime.registerPty('pty-b', TEST_WORKTREE_ID, 'ssh-1', {
      tabId: 'host-tab',
      leafId: B,
      incarnationId: 'inc-b',
      isReattach: true
    })
    for (const host of [
      makeOwnerHost({ leaves: 2, viewMode: 'chat' }),
      makeOwnerHost({ leaves: 2, viewMode: 'chat', inventoryOn: [A, B] }),
      makeOwnerHost({ leaves: 2, viewMode: 'chat', agentOn: [A], inventoryOn: [B] }),
      reattachNoReport
    ]) {
      const writes = host.writeCount()
      await host.publishedPairs()
      expect(host.hostPair()).toEqual({ viewMode: 'chat', owner: undefined })
      expect(host.writeCount()).toBe(writes)
    }

    const host = makeOwnerHost({ leaves: 2, viewMode: 'chat', activeLeafId: B, inventoryOn: [A] })
    await host.publishedPairs()
    host.runtime.registerPty('pty-a', TEST_WORKTREE_ID, null, {
      tabId: 'host-tab',
      leafId: A,
      incarnationId: 'inc-a',
      isReattach: true,
      providerReattachLaunchIdentity: { incarnationId: 'inc-a', launchAgent: 'claude' }
    })
    host.runtime.registerPty('pty-b', TEST_WORKTREE_ID, null, {
      tabId: 'host-tab',
      leafId: B,
      incarnationId: 'inc-b',
      isReattach: false
    })
    host.runtime['mobileSessionTabsByWorktree'].delete(TEST_WORKTREE_ID)
    expect(await host.publishedPairs()).toEqual([
      { viewMode: 'chat', owner: A },
      { viewMode: 'chat', owner: A }
    ])
    expect(host.hostPair()).toEqual({ viewMode: 'chat', owner: A })
  })

  it('still answers the read, unrepaired, when the store refuses the repair write', async () => {
    const host = makeOwnerHost({ leaves: 2, viewMode: 'chat', agentOn: [A], shellOn: [B] })
    vi.mocked(host.store.setWorkspaceSession!).mockImplementation(() => {
      throw new Error('Profile maintenance or finalization is blocking new terminal snapshot work')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(await host.publishedPairs()).toEqual([
        { viewMode: 'chat', owner: undefined },
        { viewMode: 'chat', owner: undefined }
      ])
      expect(host.hostPair()).toEqual({ viewMode: 'chat', owner: undefined })
      expect(warn).toHaveBeenCalledOnce()
    } finally {
      warn.mockRestore()
    }
  })

  it('leaves absent view modes, single panes and stored owners alone', async () => {
    for (const host of [
      makeOwnerHost({ leaves: 2, agentOn: [A] }),
      makeOwnerHost({ leaves: 1, viewMode: 'chat' }),
      makeOwnerHost({ leaves: 2, viewMode: 'chat', chatLeafId: 'gone', agentOn: [A] })
    ]) {
      const before = host.hostPair()
      const writes = host.writeCount()
      await host.publishedPairs()
      expect(host.hostPair()).toEqual(before)
      expect(host.writeCount()).toBe(writes)
    }
  })
})

describe('F1: a desktop-owned host relays its owner pick', () => {
  const relayHost = (options: Parameters<typeof makeOwnerHost>[0]) => {
    const host = makeOwnerHost(options)
    const setTerminalChatView = vi.fn(async () => ({ viewMode: 'chat', chatLeafId: A }))
    return { host, setTerminalChatView }
  }
  const attachDesktop = (
    host: ReturnType<typeof makeOwnerHost>,
    setTerminalChatView: ReturnType<typeof vi.fn>
  ) => {
    Reflect.set(host.runtime, 'getAvailableAuthoritativeWindow', () => ({}))
    Reflect.set(host.runtime, 'notifier', { setTerminalChatView })
  }
  const write = (host: ReturnType<typeof makeOwnerHost>, seq: number) =>
    host.runtime.setMobileSessionTabProps(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'host-tab',
      viewMode: 'chat',
      chatViewWrite: { writerId: 'W', seq }
    })

  it('sends the agent pane as the fallback owner of a parent-addressed chat', async () => {
    const { host, setTerminalChatView } = relayHost({ leaves: 2, activeLeafId: B, agentOn: [A] })
    await host.publishedPairs()
    attachDesktop(host, setTerminalChatView)

    await write(host, 1)

    expect(setTerminalChatView).toHaveBeenCalledWith(TEST_WORKTREE_ID, 'host-tab', null, 'chat', A)
  })

  it('sends an explicit no-pick when no pane runs an agent; the renderer answers (R1A-2)', async () => {
    const host = makeOwnerHost({ leaves: 2, viewMode: 'terminal' })
    const setTerminalChatView = vi.fn(async () => ({ viewMode: 'terminal', chatLeafId: null }))
    await host.publishedPairs()
    attachDesktop(host, setTerminalChatView)

    const reply = await write(host, 1)

    expect(setTerminalChatView).toHaveBeenCalledWith(
      TEST_WORKTREE_ID,
      'host-tab',
      null,
      'chat',
      null
    )
    expect(reply.chatView).toEqual({ viewMode: 'terminal', chatLeafId: null })
  })

  it('sends the pick even when the published pair has an owner; the renderer keeps a valid one', async () => {
    const { host, setTerminalChatView } = relayHost({
      leaves: 2,
      viewMode: 'chat',
      chatLeafId: B,
      agentOn: [A]
    })
    await host.publishedPairs()
    attachDesktop(host, setTerminalChatView)

    await write(host, 1)

    expect(setTerminalChatView).toHaveBeenCalledWith(TEST_WORKTREE_ID, 'host-tab', null, 'chat', A)
  })
})
