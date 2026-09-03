import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  testState,
  createStore,
  makeRepo,
  makeTerminalTab,
  writeDataFile
} from './persistence-test-harness'
import { TEST_LEAF_1, TEST_LEAF_2 } from './persistence-session-fixtures'
import { getDefaultPersistedState } from '../shared/constants'
import { sshRemotePtyLeaseAllowsReattach } from '../shared/ssh-types'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const TARGET = 'ssh-1'
const WORKTREE = 'repo1::/worktree'
const TAB = 'tab-1'
const OTHER_TAB = 'tab-moved-to'

/**
 * The renderer's published session for one SSH pane. `terminalTopologyRevisionByRepoId` is what
 * makes persisted membership authoritative — without it the host cannot tell "the user closed
 * this tab" from "the renderer has not published its layout yet".
 */
function sessionWithPane(args: {
  tabId: string
  leafId: string
  ptyId: string
  authoritative?: boolean
}) {
  return {
    activeRepoId: 'repo1',
    activeWorktreeId: WORKTREE,
    activeTabId: args.tabId,
    tabsByWorktree: {
      [WORKTREE]: [makeTerminalTab({ id: args.tabId, ptyId: args.ptyId, worktreeId: WORKTREE })]
    },
    terminalLayoutsByTabId: {
      [args.tabId]: {
        root: { type: 'leaf' as const, leafId: args.leafId },
        activeLeafId: args.leafId,
        expandedLeafId: null,
        ptyIdsByLeafId: { [args.leafId]: args.ptyId }
      }
    },
    ...(args.authoritative === false ? {} : { terminalTopologyRevisionByRepoId: { repo1: 1 } })
  }
}

/** The session after the user closes the tab: membership stays authoritative, the tab is gone. */
function sessionAfterClose() {
  return {
    activeRepoId: 'repo1',
    activeWorktreeId: WORKTREE,
    activeTabId: null,
    tabsByWorktree: { [WORKTREE]: [] },
    terminalLayoutsByTabId: {},
    terminalTopologyRevisionByRepoId: { repo1: 2 }
  }
}

/** What the relay's reattach bind does per PTY — see `restoreReattachedPtyRuntime`. */
function relayReattachBinds(
  store: ReturnType<typeof createStore>,
  args: { tabId: string; leafId: string; ptyId: string; incarnationId?: string }
): boolean | null {
  return store.persistPtyBinding({
    worktreeId: WORKTREE,
    tabId: args.tabId,
    leafId: args.leafId,
    ptyId: args.ptyId,
    ...(args.incarnationId ? { incarnationId: args.incarnationId } : {}),
    mayCreate: false,
    mayReviveRetiredSurface: false
  })
}

/**
 * Both binding writers land before the lease upsert — spawn asserts that ordering directly, and
 * the relay's reattach binds the pane before `markSshRemotePtyLeasesAttachedAsync`. Supersession
 * therefore sees a session already naming the arriving shell.
 *
 * Goes through `persistPtyBinding` rather than `setWorkspaceSession` because that is the writer
 * production uses; a raw session write is reconciled back to the attached lease's PTY by binding
 * recovery, which would make the fixture disagree with the real flow.
 */
function paneBindsTo(
  store: ReturnType<typeof createStore>,
  args: { tabId: string; leafId: string; ptyId: string }
): void {
  store.persistPtyBinding({
    worktreeId: WORKTREE,
    tabId: args.tabId,
    leafId: args.leafId,
    ptyId: args.ptyId
  })
}

function liveLeasePtyIds(store: ReturnType<typeof createStore>): string[] {
  return store
    .getSshRemotePtyLeases(TARGET)
    .filter((lease) => lease.state !== 'terminated' && lease.state !== 'expired')
    .map((lease) => lease.ptyId)
}

/**
 * What `reattachKnownPtys` actually feeds to `pty.attach`. Goes through the shipped predicate
 * rather than restating it, so the two cannot drift into the fan-out this suite exists to pin.
 */
function bulkReattachPtyIds(store: ReturnType<typeof createStore>): string[] {
  return store
    .getSshRemotePtyLeases(TARGET)
    .filter(sshRemotePtyLeaseAllowsReattach)
    .map((lease) => lease.ptyId)
}

function tabIds(store: ReturnType<typeof createStore>): string[] {
  return (store.getWorkspaceSession().tabsByWorktree?.[WORKTREE] ?? []).map((tab) => tab.id)
}

describe('STA-3077: an SSH reattach binds panes without grafting them back', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
  })
  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  // The reported user-visible bug in one assertion. `closeTab` fires pty.kill in the background
  // and only COUNTS rejections, so a transport-class failure leaves the lease non-terminated —
  // and `reattachKnownPtys` treats every non-terminated lease as live.
  it('does not resurrect a tab whose closing pty.kill failed with a transport error', async () => {
    const store = await createStore()
    store.setWorkspaceSession(sessionWithPane({ tabId: TAB, leafId: TEST_LEAF_1, ptyId: 'pty-1' }))
    store.upsertSshRemotePtyLease({
      targetId: TARGET,
      ptyId: 'pty-1',
      worktreeId: WORKTREE,
      tabId: TAB,
      leafId: TEST_LEAF_1,
      state: 'attached'
    })
    // The user closes the tab; the remote kill never lands, so the lease survives untouched.
    store.setWorkspaceSession(sessionAfterClose())

    const bound = relayReattachBinds(store, {
      tabId: TAB,
      leafId: TEST_LEAF_1,
      ptyId: 'pty-1',
      incarnationId: 'inc-1'
    })

    expect(bound).toBe(false)
    expect(tabIds(store)).toEqual([])
  })

  // Tripwire: a refusal must not depend on the pane sitting where its lease says it does.
  // `detachTerminalPaneToTab` moves a live pane, and the lease keeps naming the tab it left.
  it('binds a pane that moved to another tab rather than refusing it', async () => {
    const store = await createStore()
    store.setWorkspaceSession(
      sessionWithPane({ tabId: OTHER_TAB, leafId: TEST_LEAF_1, ptyId: 'pty-1' })
    )

    const { findTerminalTabIdForLeaf } =
      await import('./runtime/workspace-session-terminal-membership-authority')
    // The relay resolves the tab from the live layout before binding, exactly as the production
    // path does; forwarding the lease's frozen `TAB` here is what would strand the pane.
    const resolvedTabId = findTerminalTabIdForLeaf(store.getWorkspaceSession(), TEST_LEAF_1)
    expect(resolvedTabId).toBe(OTHER_TAB)

    const bound = relayReattachBinds(store, {
      tabId: resolvedTabId!,
      leafId: TEST_LEAF_1,
      ptyId: 'pty-2',
      incarnationId: 'inc-2'
    })

    expect(bound).toBe(true)
    expect(
      store.getWorkspaceSession().terminalLayoutsByTabId?.[OTHER_TAB]?.ptyIdsByLeafId?.[TEST_LEAF_1]
    ).toBe('pty-2')
  })

  // Losing a tab is worse than keeping a duplicate. Before the renderer publishes a layout the
  // host cannot read absence as a close, so the creating write must still be allowed — this is
  // the disconnect/reconnect tab loss that reverted this fix twice.
  it('still binds when the session is not yet authoritative for the worktree', async () => {
    const store = await createStore()

    const bound = store.persistPtyBinding({
      worktreeId: WORKTREE,
      tabId: TAB,
      leafId: TEST_LEAF_1,
      ptyId: 'pty-1',
      incarnationId: 'inc-1',
      // The relay passes mayCreate:false only once membership is authoritative; an unauthoritative
      // session takes the creating write instead.
      ...(store.getWorkspaceSession().terminalTopologyRevisionByRepoId?.repo1
        ? { mayCreate: false }
        : {})
    })

    expect(bound).toBe(true)
    expect(tabIds(store)).toEqual([TAB])
  })

  it('does not clear and rebind a retired surface loaded from an older profile', async () => {
    const paneKey = `${TAB}:${TEST_LEAF_1}`
    const persisted = getDefaultPersistedState(testState.dir)
    // Registered on purpose: rows owned by an unregistered repo id are swept as orphans on load.
    persisted.repos = [makeRepo({ id: 'repo1', path: '/repo1' })]
    persisted.workspaceSession = {
      ...persisted.workspaceSession,
      ...sessionWithPane({ tabId: TAB, leafId: TEST_LEAF_1, ptyId: 'pty-1' }),
      terminalPtyIncarnationsByPaneKey: { [paneKey]: 'inc-1' },
      terminalSurfaceTombstonesByPaneKey: {
        [paneKey]: {
          worktreeId: WORKTREE,
          parentTabId: TAB,
          leafId: TEST_LEAF_1,
          ptyId: 'pty-1',
          incarnationId: 'inc-1',
          retiredAt: 1
        }
      }
    }
    writeDataFile(persisted)
    const store = await createStore()

    expect(store.getWorkspaceSession().terminalSurfaceTombstonesByPaneKey?.[paneKey]).toBeDefined()
    expect(
      relayReattachBinds(store, {
        tabId: TAB,
        leafId: TEST_LEAF_1,
        ptyId: 'pty-1',
        incarnationId: 'inc-1'
      })
    ).toBe(false)
    expect(store.getWorkspaceSession().terminalSurfaceTombstonesByPaneKey?.[paneKey]).toBeDefined()
    expect(
      store.getWorkspaceSession().terminalLayoutsByTabId?.[TAB]?.ptyIdsByLeafId?.[TEST_LEAF_1]
    ).toBe('pty-1')
  })

  it('refuses to graft a second leaf into a tab the reattach does not already own', async () => {
    const store = await createStore()
    store.setWorkspaceSession(sessionWithPane({ tabId: TAB, leafId: TEST_LEAF_1, ptyId: 'pty-1' }))

    const bound = relayReattachBinds(store, {
      tabId: TAB,
      leafId: TEST_LEAF_2,
      ptyId: 'pty-2',
      incarnationId: 'inc-2'
    })

    expect(bound).toBe(false)
    const layout = store.getWorkspaceSession().terminalLayoutsByTabId?.[TAB]
    expect(layout?.ptyIdsByLeafId?.[TEST_LEAF_2]).toBeUndefined()
    expect(layout?.root).toEqual({ type: 'leaf', leafId: TEST_LEAF_1 })
  })

  // A close raises the repo's topology revision, and that is what the fence reads. Pinned as
  // behavior because `terminalSurfaceTombstonesByPaneKey` — the older per-surface fence — is
  // consumed and cleared by `sanitizeWorkspaceSessionTerminalRetirements` on every session write,
  // so it is never present by the time a binding write could consult it.
  it('treats a raised topology revision as the authority that makes absence a close', async () => {
    const store = await createStore()
    store.setWorkspaceSession(sessionWithPane({ tabId: TAB, leafId: TEST_LEAF_1, ptyId: 'pty-1' }))
    store.setWorkspaceSession(sessionAfterClose())

    const session = store.getWorkspaceSession()
    expect(session.terminalTopologyRevisionByRepoId?.repo1).toBeGreaterThan(0)
    expect(session.terminalSurfaceTombstonesByPaneKey ?? {}).toEqual({})
    expect(relayReattachBinds(store, { tabId: TAB, leafId: TEST_LEAF_1, ptyId: 'pty-1' })).toBe(
      false
    )
  })
})

describe('STA-3077: one pane keeps at most one live remote lease', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
  })
  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  // The 2 -> 19 -> 20 mechanism: lease identity was `(targetId, ptyId)` alone, so a reconnect
  // minting a new relay id left its predecessor live with nothing to retire it.
  it('retires the predecessor when a pane re-leases under a new relay pty id', async () => {
    const store = await createStore()
    store.setWorkspaceSession(sessionWithPane({ tabId: TAB, leafId: TEST_LEAF_1, ptyId: 'pty-1' }))
    const lease = { targetId: TARGET, worktreeId: WORKTREE, tabId: TAB, leafId: TEST_LEAF_1 }
    store.upsertSshRemotePtyLease({ ...lease, ptyId: 'pty-1', state: 'attached' })

    paneBindsTo(store, { tabId: TAB, leafId: TEST_LEAF_1, ptyId: 'pty-2' })
    store.upsertSshRemotePtyLease({ ...lease, ptyId: 'pty-2', state: 'attached' })

    expect(liveLeasePtyIds(store)).toEqual(['pty-2'])
  })

  // Superseding must not assert a death nobody observed — the remote shell is deliberately left
  // running, so the predecessor is `expired`, never `terminated`.
  it('marks the superseded lease expired rather than terminated', async () => {
    const store = await createStore()
    store.setWorkspaceSession(sessionWithPane({ tabId: TAB, leafId: TEST_LEAF_1, ptyId: 'pty-1' }))
    const lease = { targetId: TARGET, worktreeId: WORKTREE, tabId: TAB, leafId: TEST_LEAF_1 }
    store.upsertSshRemotePtyLease({ ...lease, ptyId: 'pty-1', state: 'attached' })

    paneBindsTo(store, { tabId: TAB, leafId: TEST_LEAF_1, ptyId: 'pty-2' })
    store.upsertSshRemotePtyLease({ ...lease, ptyId: 'pty-2', state: 'attached' })

    const predecessor = store.getSshRemotePtyLeases(TARGET).find((entry) => entry.ptyId === 'pty-1')
    expect(predecessor?.state).toBe('expired')
  })

  // The reported growth: live claims must not scale with reconnect count.
  it('holds the live lease count flat across ten reconnects of one pane', async () => {
    const store = await createStore()
    store.setWorkspaceSession(sessionWithPane({ tabId: TAB, leafId: TEST_LEAF_1, ptyId: 'pty-0' }))
    const lease = { targetId: TARGET, worktreeId: WORKTREE, tabId: TAB, leafId: TEST_LEAF_1 }

    for (let reconnect = 0; reconnect < 10; reconnect++) {
      paneBindsTo(store, { tabId: TAB, leafId: TEST_LEAF_1, ptyId: `pty-${reconnect}` })
      store.upsertSshRemotePtyLease({ ...lease, ptyId: `pty-${reconnect}`, state: 'attached' })
    }

    expect(liveLeasePtyIds(store)).toEqual(['pty-9'])
  })

  // A pane broken out into its own tab keeps its leaf but not its tabId. Keying supersession on
  // the tab would stop it competing with its own predecessor — the cardinality growth again.
  it('supersedes across a tab change, because the leaf is the pane identity', async () => {
    const store = await createStore()
    store.setWorkspaceSession(sessionWithPane({ tabId: TAB, leafId: TEST_LEAF_1, ptyId: 'pty-1' }))
    store.upsertSshRemotePtyLease({
      targetId: TARGET,
      ptyId: 'pty-1',
      worktreeId: WORKTREE,
      tabId: TAB,
      leafId: TEST_LEAF_1,
      state: 'attached'
    })

    paneBindsTo(store, { tabId: TAB, leafId: TEST_LEAF_1, ptyId: 'pty-2' })
    // The successor's lease names the tab the pane sits in NOW; the predecessor's still names the
    // one it was written in. Only the leaf is common, so keying on the tab would stop the two
    // competing and leave both live — the cardinality growth.
    store.upsertSshRemotePtyLease({
      targetId: TARGET,
      ptyId: 'pty-2',
      worktreeId: WORKTREE,
      tabId: OTHER_TAB,
      leafId: TEST_LEAF_1,
      state: 'attached'
    })

    expect(liveLeasePtyIds(store)).toEqual(['pty-2'])
  })

  // Expiring the lease the pane is actually bound to would detach a live pane. When the arriving
  // lease is not yet the bound one, both stay live and reattach arbitrates with the binding.
  it('leaves both live when the pane is still bound to the predecessor', async () => {
    const store = await createStore()
    store.setWorkspaceSession(sessionWithPane({ tabId: TAB, leafId: TEST_LEAF_1, ptyId: 'pty-1' }))
    const lease = { targetId: TARGET, worktreeId: WORKTREE, tabId: TAB, leafId: TEST_LEAF_1 }
    store.upsertSshRemotePtyLease({ ...lease, ptyId: 'pty-1', state: 'attached' })

    // A lease arrives for a shell the pane has NOT bound; the binding still names pty-1.
    store.upsertSshRemotePtyLease({ ...lease, ptyId: 'pty-9', state: 'detached' })

    expect(liveLeasePtyIds(store).sort()).toEqual(['pty-1', 'pty-9'])
  })

  // Panes are independent: superseding one must not touch a sibling's lease.
  it('does not supersede a different pane in the same worktree', async () => {
    const store = await createStore()
    store.setWorkspaceSession(sessionWithPane({ tabId: TAB, leafId: TEST_LEAF_1, ptyId: 'pty-1' }))
    store.upsertSshRemotePtyLease({
      targetId: TARGET,
      ptyId: 'sibling-pty',
      worktreeId: WORKTREE,
      tabId: TAB,
      leafId: TEST_LEAF_2,
      state: 'attached'
    })
    const lease = { targetId: TARGET, worktreeId: WORKTREE, tabId: TAB, leafId: TEST_LEAF_1 }
    store.upsertSshRemotePtyLease({ ...lease, ptyId: 'pty-1', state: 'attached' })

    paneBindsTo(store, { tabId: TAB, leafId: TEST_LEAF_1, ptyId: 'pty-2' })
    store.upsertSshRemotePtyLease({ ...lease, ptyId: 'pty-2', state: 'attached' })

    expect(liveLeasePtyIds(store).sort()).toEqual(['pty-2', 'sibling-pty'])
  })

  // Characterises the merge that makes relay pty-id RECYCLING dangerous: a lease upserted without
  // pane fields inherits whatever pane the matched record named. Correct for a same-shell
  // re-upsert, which is why it exists; unsafe when the relay restarted and handed this id to a
  // different shell. Pinned so a future change to the merge is a deliberate one.
  it('inherits stored pane fields when a lease re-upserts without them', async () => {
    const store = await createStore()
    store.upsertSshRemotePtyLease({
      targetId: TARGET,
      ptyId: 'pty-1',
      worktreeId: WORKTREE,
      tabId: TAB,
      leafId: TEST_LEAF_1,
      state: 'attached'
    })

    store.upsertSshRemotePtyLease({
      targetId: TARGET,
      ptyId: 'pty-1',
      worktreeId: undefined,
      tabId: undefined,
      leafId: undefined,
      state: 'detached'
    } as never)

    expect(store.getSshRemotePtyLeases(TARGET)[0]).toMatchObject({
      ptyId: 'pty-1',
      tabId: TAB,
      leafId: TEST_LEAF_1,
      state: 'detached'
    })
  })
})

describe('STA-3077: `expired` separates a superseded sibling from an orphan', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
  })
  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  const paneLease = { targetId: TARGET, worktreeId: WORKTREE, tabId: TAB, leafId: TEST_LEAF_1 }

  async function storeWithPane(ptyId: string) {
    const store = await createStore()
    store.setWorkspaceSession(sessionWithPane({ tabId: TAB, leafId: TEST_LEAF_1, ptyId }))
    store.upsertSshRemotePtyLease({ ...paneLease, ptyId, state: 'attached' })
    return store
  }

  // The negative control on the whole change: reattaching the predecessor is the 2 -> 19 -> 20
  // fan-out, and supersession is the only evidence that separates it from an orphan.
  it('never bulk-reattaches a superseded sibling', async () => {
    const store = await storeWithPane('pty-1')

    paneBindsTo(store, { tabId: TAB, leafId: TEST_LEAF_1, ptyId: 'pty-2' })
    store.upsertSshRemotePtyLease({ ...paneLease, ptyId: 'pty-2', state: 'attached' })

    const predecessor = store.getSshRemotePtyLeases(TARGET).find((entry) => entry.ptyId === 'pty-1')
    expect(predecessor).toMatchObject({ state: 'expired', supersededBy: 'pty-2' })
    expect(bulkReattachPtyIds(store)).toEqual(['pty-2'])
  })

  // The cardinality invariant restated on the set that actually reaches `pty.attach`.
  it('holds the bulk reattach set flat across ten reconnects of one pane', async () => {
    const store = await createStore()
    store.setWorkspaceSession(sessionWithPane({ tabId: TAB, leafId: TEST_LEAF_1, ptyId: 'pty-0' }))

    for (let reconnect = 0; reconnect < 10; reconnect++) {
      paneBindsTo(store, { tabId: TAB, leafId: TEST_LEAF_1, ptyId: `pty-${reconnect}` })
      store.upsertSshRemotePtyLease({ ...paneLease, ptyId: `pty-${reconnect}`, state: 'attached' })
    }

    expect(bulkReattachPtyIds(store)).toEqual(['pty-9'])
  })

  // The orphan the split buys back: nothing observed this shell, so the bulk path may ask.
  it('bulk-reattaches an expired lease whose reattach only lost contact', async () => {
    const store = await storeWithPane('pty-1')

    store.markSshRemotePtyLease(TARGET, 'pty-1', 'expired')

    const orphan = store.getSshRemotePtyLeases(TARGET)[0]
    expect(orphan).toMatchObject({ state: 'expired' })
    expect(orphan.supersededBy).toBeUndefined()
    expect(orphan.relayIdRecycled).toBeUndefined()
    expect(bulkReattachPtyIds(store)).toEqual(['pty-1'])
  })

  // Without this the orphan above stays reattachable forever and every past reconnect adds one
  // more `pty.attach` to each handshake. A newer lease is the same evidence either way.
  it('marks an already-expired orphan superseded once a newer lease wins the pane', async () => {
    const store = await storeWithPane('pty-1')
    store.markSshRemotePtyLease(TARGET, 'pty-1', 'expired')
    const orphanUpdatedAt = store.getSshRemotePtyLeases(TARGET)[0].updatedAt

    paneBindsTo(store, { tabId: TAB, leafId: TEST_LEAF_1, ptyId: 'pty-2' })
    store.upsertSshRemotePtyLease({ ...paneLease, ptyId: 'pty-2', state: 'attached' })

    const predecessor = store.getSshRemotePtyLeases(TARGET).find((entry) => entry.ptyId === 'pty-1')
    expect(predecessor).toMatchObject({ state: 'expired', supersededBy: 'pty-2' })
    // `getRecentExpiredSshLease` reads `updatedAt` as recency; a stale lease must not look fresh.
    expect(predecessor?.updatedAt).toBe(orphanUpdatedAt)
    expect(bulkReattachPtyIds(store)).toEqual(['pty-2'])
  })

  // A relay renumbers from `pty-1` on every start, so this row can be a different shell. The mark
  // belongs to the lease that lost, never to whatever claims the id next.
  it('clears the supersession mark when the id is re-upserted as a live lease', async () => {
    const store = await storeWithPane('pty-1')
    paneBindsTo(store, { tabId: TAB, leafId: TEST_LEAF_1, ptyId: 'pty-2' })
    store.upsertSshRemotePtyLease({ ...paneLease, ptyId: 'pty-2', state: 'attached' })

    // A restarted relay hands `pty-1` to a new shell for a different pane.
    store.upsertSshRemotePtyLease({
      targetId: TARGET,
      ptyId: 'pty-1',
      worktreeId: WORKTREE,
      tabId: OTHER_TAB,
      leafId: TEST_LEAF_2,
      state: 'attached'
    })

    const recycled = store.getSshRemotePtyLeases(TARGET).find((entry) => entry.ptyId === 'pty-1')
    expect(recycled?.supersededBy).toBeUndefined()
    expect(bulkReattachPtyIds(store).sort()).toEqual(['pty-1', 'pty-2'])
  })

  // The pending-stop replay's `relay-id-recycled` retirement relied on `expired` alone to keep the
  // lease out of the reattach that runs one step later; it now says so.
  it('never bulk-reattaches a lease whose relay id was recycled', async () => {
    const store = await storeWithPane('pty-1')

    store.markSshRemotePtyLease(TARGET, 'pty-1', 'expired', { relayIdRecycled: true })

    expect(store.getSshRemotePtyLeases(TARGET)[0]).toMatchObject({ relayIdRecycled: true })
    expect(bulkReattachPtyIds(store)).toEqual([])
  })

  it('never bulk-reattaches a terminated lease, marked or not', async () => {
    const store = await storeWithPane('pty-1')

    store.markSshRemotePtyLease(TARGET, 'pty-1', 'terminated')

    expect(bulkReattachPtyIds(store)).toEqual([])
  })
})
