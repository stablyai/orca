import '../rpc/unused-default-rpc-methods.test-fixture'
import { expect, it, vi } from 'vitest'
import { createRuntimeAgentProjections } from '../construction/runtime-agent-projections'
import { MIRROR_LEAVES_STEP_1 } from '../runtime-leaf-record-projection.test-fixture'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from '../runtime-terminal-state-records'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { RuntimeSessionTabsInventoryPublication as Census } from './session-tabs-inventory-publication'
import { OrcaRuntimeWithCollectMobileVisibleGraphChangedWorktrees as Inventory } from './session-tabs-inventory'
import { OrcaRuntimeWithScheduleMobileSessionTabsChanged as Publication } from './session-tabs-change-publication'

import { OrcaRuntimeWithResolveKnownWorkspaceFileTarget as Subscriptions } from '../workspaces/known-workspace-file-target'
import { OrcaRuntimeWithBuildHeadlessMobileSessionBrowserTabs as Headless } from '../session-lifecycle/projection/build-headless-mobile-session-browser-tabs'
import { RuntimeSubscriptionRegistry } from '../runtime-subscription-registry'
import { RpcDispatcher } from '../rpc/dispatcher'
import { SESSION_TAB_METHODS } from '../rpc/methods/session-tabs'
import type { OrcaRuntimeService } from '../orca-runtime'

const unissued = (): never => {
  throw new Error('a sender build issued a terminal handle')
}

const WORKTREES = 20

// The runtime's own pass methods under test; protected, so reached through their prototypes.
const collectAllMobileSessionTabs = Inventory.prototype['collectAllMobileSessionTabs']
const notifyMobileSessionTabSnapshots = Publication.prototype['notifyMobileSessionTabSnapshots']
const toMobileSessionTabsFrames = Publication.prototype['toMobileSessionTabsFrames']
const leafOf = (i: number) => `${(i + 1).toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`

/** The runtime parts an inventory or broadcast pass reads, with `terminals` live terminals over
 *  20 worktrees; the passes and the frame builder are the runtime's own methods. */
function runtime(terminals: number, desktop = true) {
  let databaseReads = 0
  const leaves: RuntimeLeafRecord[] = []
  const ptys: RuntimePtyWorktreeRecord[] = []
  for (let i = 0; i < terminals; i++) {
    const worktreeId = `w${i % WORKTREES}`
    leaves.push({ ...MIRROR_LEAVES_STEP_1[0], tabId: `tab${i}`, worktreeId, ptyId: `pty-${i}` })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the publisher reads only these fields.
    ptys.push({ ptyId: `pty-${i}`, incarnationId: 'inc', worktreeId } as RuntimePtyWorktreeRecord)
  }
  const agentProjections = createRuntimeAgentProjections(
    {
      getExistingOrchestrationDb: () => null,
      resolveOrchestrationWorkerServer: () => {
        throw new Error('unpaired')
      }
    },
    {
      getDb: () => {
        databaseReads++
        return null
      },
      getLeaves: () => leaves,
      getPtys: () => ptys,
      paneOf: () => ({ tabId: null, paneKey: null, recordedAtGraphSequence: 0 }),
      // Orchestration issues handles; sender rows only read the ones already issued.
      issueLeafHandle: unissued,
      issuePtyHandle: unissued,
      readLeafHandle: (leaf) => `term_${leaf.tabId}`,
      readPtyHandles: () => () => null,
      makePaneKey: (leaf) => `${leaf.tabId}:${leafOf(Number(leaf.tabId.slice(3)))}`,
      getWorktreeId: () => null,
      getHandleForPaneKey: () => null,
      getPaneKey: () => null,
      getDispatchAuthority: () => null,
      getAgentStatusSnapshot: () => [],
      getSessionRecords: () => null
    }
  )
  const frames: RuntimeMobileSessionTabsResult[] = []
  const snapshot = (worktree: string) => ({
    worktree,
    publicationEpoch: 'host',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: []
  })
  const registry = new RuntimeSubscriptionRegistry()
  const host = {
    agentProjections,
    getRuntimeId: () => 'sender-test',
    onMobileSessionTabsChanged: Subscriptions.prototype.onMobileSessionTabsChanged,
    hasAgentSenderListeners: Subscriptions.prototype['hasAgentSenderListeners'],
    releaseAgentSenderHistoryIfUnobserved:
      Subscriptions.prototype['releaseAgentSenderHistoryIfUnobserved'],
    mobileSessionTabsNotifyCoalescer: { flushAll: () => undefined },
    mobileSessionTabsAgentStatusHeartbeat: { cancelPending: () => undefined },
    registerSubscriptionCleanup: registry.register.bind(registry),
    cleanupSubscription: registry.cleanup.bind(registry),
    cleanupSubscriptionsByPrefix: registry.cleanupByPrefix.bind(registry),
    supportsAuthoritativeSessionTabsInventory: () => true,
    getAuthoritativeSessionTabsInventoryEpoch: (): number | null => 1,
    waitForSessionTabsInventoryPublication: async () => undefined,
    assertSessionTabsInventoryRequestActive:
      Census.prototype['assertSessionTabsInventoryRequestActive'],
    isCompleteSessionTabsPtyCensus: () => true,
    getExplicitSessionWorktreeIdSelector: (selector: string) => selector.slice(3),
    refreshMobileSessionPtyRecords: async () => undefined,
    getMobileSessionTabsForWorktree: Publication.prototype['getMobileSessionTabsForWorktree'],
    toMobileSessionTabsFrame: Publication.prototype['toMobileSessionTabsFrame'],
    withMobileSessionTabSenders: Publication.prototype['withMobileSessionTabSenders'],
    emptyMobileSessionTabsResult: Publication.prototype['emptyMobileSessionTabsResult'],
    notifyEmptyWorktreeOnPublication: Publication.prototype['notifyEmptyWorktreeOnPublication'],
    createMobileSessionTabsDelivery: Publication.prototype['createMobileSessionTabsDelivery'],
    emitMobileSessionTabsSnapshotToClient:
      Publication.prototype['emitMobileSessionTabsSnapshotToClient'],
    worktreesAwaitingSessionTabsPublication: new Set<string>(),
    sessionTabsInventoryWaiters: new Set<() => void>(),
    listMobileSessionTabs: Inventory.prototype.listMobileSessionTabs,
    listAllMobileSessionTabs: Inventory.prototype.listAllMobileSessionTabs,
    listAllMobileSessionTabsWithChangeSequence:
      Inventory.prototype.listAllMobileSessionTabsWithChangeSequence,
    listAllMobileSessionTabsInventory: Inventory.prototype.listAllMobileSessionTabsInventory,
    listAllMobileSessionTabsInventoryWithChangeSequence:
      Inventory.prototype.listAllMobileSessionTabsInventoryWithChangeSequence,
    collectAllMobileSessionTabs,
    settleSessionTabsInventory: Inventory.prototype['settleSessionTabsInventory'],
    mobileSessionTabsByWorktree: new Map(
      Array.from({ length: WORKTREES }, (_, i) => [`w${i}`, snapshot(`w${i}`)])
    ),
    mobileSessionTabsChangeSequence: 0,
    mobileSessionTabListeners: new Set<{
      listener: (frame: RuntimeMobileSessionTabsResult, sequence: number) => void
      clientKind?: 'mobile' | 'runtime'
      clientNavigationId?: string
    }>(
      desktop ? [{ listener: (frame: RuntimeMobileSessionTabsResult) => frames.push(frame) }] : []
    ),
    getKnownWorkspaceSessionWorktreeIds: () => [],
    hydrateHeadlessMobileSessionTabsFromWorkspaceSession: () => undefined,
    refreshMobileSessionPtyInventory: async () => null,
    restoreLivePairedRendererSessionOwnedMobileTerminals: () => undefined,
    projectMobileSessionTabsForClient: (frame: RuntimeMobileSessionTabsResult) => frame,
    toMobileSessionTabsResult: (frame: RuntimeMobileSessionTabsResult) => frame,
    toMobileSessionTabsFrames
  }
  const walks = () => agentProjections.senders.workForTest()
  return {
    host,
    databaseReads: () => databaseReads,
    leaves,
    ptys,
    rpc: new RpcDispatcher({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these production routes use only the runtime methods supplied above; missing methods fail the contract.
      runtime: host as unknown as OrcaRuntimeService,
      methods: SESSION_TAB_METHODS
    }),
    senders: agentProjections.senders,
    frames,
    walks,
    inventory: () => collectAllMobileSessionTabs.call(host),
    broadcast: () => notifyMobileSessionTabSnapshots.call(host)
  }
}

it.each([100, 1000])(
  'walks the live terminals once per inventory or broadcast pass, at %i terminals',
  async (terminals) => {
    const h = runtime(terminals)
    h.senders.build()
    const revision = h.senders.publisher.current().revision
    const pass = async (run: () => unknown) => {
      const before = h.walks()
      await run()
      const after = h.walks()
      return {
        leaves: after.leafVisits - before.leafVisits,
        ptys: after.ptyVisits - before.ptyVisits
      }
    }
    const once = { leaves: terminals, ptys: terminals }
    const listed = await h.inventory()
    expect(listed.snapshots).toHaveLength(WORKTREES)
    expect(listed.snapshots[3].agentSenderAssociations?.associations).toHaveLength(
      terminals / WORKTREES
    )
    expect(await pass(h.inventory)).toEqual(once)
    expect(await pass(h.broadcast)).toEqual(once)
    expect(h.frames).toHaveLength(WORKTREES)
    // One graph build or one frame walks them once too; unchanged terminals publish nothing.
    expect(await pass(() => h.senders.buildForGraph(revision))).toEqual(once)
    expect(await pass(() => h.senders.buildForFrame('w0'))).toEqual(once)
    expect(h.senders.publisher.current().revision).toEqual(revision)
  }
)

it.each([100, 1000])(
  'admits sender work only at real desktop delivery across production RPC routes, at %i terminals',
  async (terminals) => {
    const h = runtime(terminals, false)
    const request = (method: string, id: string) => ({
      id,
      authToken: 'test',
      method,
      ...(method.endsWith('All') ? {} : { params: { worktree: 'id:w0' } })
    })
    const mobile: { ok: boolean }[] = []
    const mobileAbort = new AbortController()
    for (const method of [
      'session.tabs.list',
      'session.tabs.listAll',
      'session.tabs.subscribe',
      'session.tabs.subscribeAll'
    ]) {
      await h.rpc.dispatchStreaming(
        request(method, method),
        (frame) => mobile.push(JSON.parse(frame)),
        { clientKind: 'mobile', connectionId: method, signal: mobileAbort.signal }
      )
    }
    await h.rpc.dispatchStreaming(
      {
        id: 'missing',
        authToken: 'test',
        method: 'session.tabs.list',
        params: { worktree: 'id:missing' }
      },
      (frame) => mobile.push(JSON.parse(frame)),
      { clientKind: 'mobile' }
    )
    h.broadcast()
    Headless.prototype['emitMobileSessionTabsSnapshot'].call(
      h.host,
      h.host.mobileSessionTabsByWorktree.get('w0')!
    )
    h.host.emitMobileSessionTabsSnapshotToClient(
      h.host.mobileSessionTabsByWorktree.get('w0')!,
      'phone',
      true
    )
    expect(mobile.every((frame) => frame.ok)).toBe(true)
    expect(h.walks()).toMatchObject({
      leafVisits: 0,
      ptyVisits: 0,
      historyReads: 0,
      lineageReads: 0,
      paneReads: 0
    })
    expect(h.databaseReads()).toBe(0)
    expect(JSON.stringify(mobile)).not.toContain('agentSenderAssociations')

    const desktop: { result: RuntimeMobileSessionTabsResult }[] = []
    const release = vi.spyOn(h.senders, 'releaseDerivedHistory')
    const firstDesktop = new AbortController()
    await h.rpc.dispatchStreaming(
      request('session.tabs.subscribe', 'desktop'),
      (frame) => desktop.push(JSON.parse(frame)),
      { connectionId: 'desktop', clientKind: 'runtime', signal: firstDesktop.signal }
    )
    expect(desktop[0]).toMatchObject({ ok: true })
    // Single subscribe obtains complete identity before registering its ongoing listener.
    expect(desktop[0]?.result.agentSenderAssociations?.associations).toHaveLength(
      terminals / WORKTREES
    )
    expect(release).toHaveBeenCalledTimes(1)
    release.mockClear()
    const secondDesktop = new AbortController()
    await h.rpc.dispatchStreaming(
      request('session.tabs.subscribeAll', 'desktop-all'),
      (frame) => desktop.push(JSON.parse(frame)),
      { connectionId: 'desktop-all', clientKind: 'runtime', signal: secondDesktop.signal }
    )
    const before = h.walks()
    h.broadcast()
    expect(h.walks().leafVisits - before.leafVisits).toBe(terminals)
    expect(h.walks().ptyVisits - before.ptyVisits).toBe(terminals)
    firstDesktop.abort()
    expect(release).not.toHaveBeenCalled()
    secondDesktop.abort()
    expect(release).toHaveBeenCalledTimes(1)
    const dormant = h.walks()
    h.broadcast()
    await h.host.listAllMobileSessionTabs(undefined, { includeAgentSenders: false })
    expect(h.walks()).toEqual(dormant)

    h.leaves.push({ ...h.leaves[0], tabId: 'new', ptyId: 'new-pty' })
    const reconnected: { result: RuntimeMobileSessionTabsResult }[] = []
    const reconnectAbort = new AbortController()
    // Unknown public clients remain compatible with desktop sender delivery.
    await h.rpc.dispatchStreaming(
      request('session.tabs.subscribe', 'reconnect'),
      (frame) => reconnected.push(JSON.parse(frame)),
      { connectionId: 'reconnect', signal: reconnectAbort.signal }
    )
    expect(reconnected[0]?.result.agentSenderAssociations?.associations).toHaveLength(
      terminals / WORKTREES + 1
    )
    reconnectAbort.abort()
    mobileAbort.abort()
    release.mockRestore()
  }
)

it('does no sender work for zero-snapshot inventory or unpublished phone empty notifications', async () => {
  const h = runtime(100, false)
  h.host.mobileSessionTabsByWorktree.clear()
  expect((await h.inventory()).snapshots).toEqual([])
  h.host.getAuthoritativeSessionTabsInventoryEpoch = () => 0
  h.host.getMobileSessionTabsForWorktree('empty', undefined, { includeAgentSenders: false })
  h.host.getAuthoritativeSessionTabsInventoryEpoch = (): number | null => null
  h.host.getMobileSessionTabsForWorktree('unpublished', undefined, { includeAgentSenders: false })
  h.host.getAuthoritativeSessionTabsInventoryEpoch = () => 1
  h.host.onMobileSessionTabsChanged(() => undefined, 'phone', 'mobile')
  for (const published of h.host.sessionTabsInventoryWaiters) {
    published()
  }
  expect(h.walks()).toMatchObject({ leafVisits: 0, ptyVisits: 0, historyReads: 0 })
  expect(h.databaseReads()).toBe(0)
})

it('keeps changes pending across a one-shot read and targeted navigation until every desktop gets the exact broadcast', async () => {
  const h = runtime(100, false)
  const desktopA: RuntimeMobileSessionTabsResult[] = []
  const desktopB: RuntimeMobileSessionTabsResult[] = []
  let changeDuringBroadcast = false
  const append = (i: number) =>
    h.leaves.push({ ...h.leaves[0], tabId: `tab${i}`, worktreeId: 'w0', ptyId: `pty-${i}` })
  const stopA = h.host.onMobileSessionTabsChanged(
    (frame) => {
      if (frame.worktree === 'w0') {
        desktopA.push(frame)
        if (changeDuringBroadcast) {
          changeDuringBroadcast = false
          append(101)
          h.senders.build()
        }
      }
    },
    'desktop-a',
    'runtime'
  )
  const stopB = h.host.onMobileSessionTabsChanged(
    (frame) => {
      if (frame.worktree === 'w0') {
        desktopB.push(frame)
      }
    },
    'desktop-b',
    'runtime'
  )
  const stopPhone = h.host.onMobileSessionTabsChanged(
    (frame) => {
      expect(frame.agentSenderAssociations).toBeUndefined()
    },
    'phone',
    'mobile'
  )
  h.broadcast()
  const original = desktopB.at(-1)?.agentSenderAssociations
  expect(h.senders.changedScopes(['w0'])).toEqual([])
  const acknowledge = vi.spyOn(h.senders, 'acknowledgeFrame')

  append(100)
  const oneShot = await h.host.listMobileSessionTabs('id:w0', 'desktop-a')
  expect(oneShot.agentSenderAssociations?.associations).toHaveLength(6)
  expect(h.senders.changedScopes(['w0'])).toEqual(['w0'])
  h.host.emitMobileSessionTabsSnapshotToClient(oneShot, 'desktop-a', true)
  expect(desktopA.at(-1)?.agentSenderAssociations).toBe(oneShot.agentSenderAssociations)
  expect(desktopB.at(-1)?.agentSenderAssociations).toBe(original)
  expect(acknowledge).not.toHaveBeenCalled()
  expect(h.senders.changedScopes(['w0'])).toEqual(['w0'])

  // A newer identity built during delivery stays pending after this complete older frame.
  changeDuringBroadcast = true
  h.broadcast()
  const delivered = desktopB.at(-1)?.agentSenderAssociations
  expect(delivered).toBe(oneShot.agentSenderAssociations)
  expect(desktopA.at(-1)?.agentSenderAssociations).toBe(delivered)
  expect(acknowledge.mock.calls.find(([worktree]) => worktree === 'w0')?.[1]).toBe(delivered)
  expect(h.senders.changedScopes(['w0'])).toEqual(['w0'])
  h.broadcast()
  expect(desktopB.at(-1)?.agentSenderAssociations?.associations).toHaveLength(7)
  expect(desktopA.at(-1)?.agentSenderAssociations).toBe(desktopB.at(-1)?.agentSenderAssociations)
  expect(h.senders.changedScopes(['w0'])).toEqual([])
  stopA()
  stopB()
  stopPhone()
  acknowledge.mockRestore()
})
