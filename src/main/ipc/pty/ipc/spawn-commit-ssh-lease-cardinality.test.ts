import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { testState, createStore } from '../../../persistence-test-harness'
import { TEST_LEAF_1, TEST_LEAF_2 } from '../../../persistence-session-fixtures'
import { sshRemotePtyLeaseAllowsReattach } from '../../../../shared/ssh-types'
import { toAppSshPtyId } from '../../../providers/ssh-pty-id'
import { toSshExecutionHostId } from '../../../../shared/execution-host'
import type { PtySpawnIpcArgs, PtySpawnIpcDeps } from './spawn-types'
import { createPtyIpcSpawnState } from './spawn-state'
import { persistPtyIpcSpawnCommit } from './spawn-commit-persist'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const TARGET = 'ssh-1'
const WORKTREE = 'repo1::/worktree'
const TAB = 'tab-1'

/**
 * Drives the shipped IPC spawn commit rather than the store primitives it calls.
 *
 * The store-level suite could not catch this: it exercised bind-then-upsert, and this path does the
 * opposite — it writes the lease row first so a force-quit in the renderer's debounce window cannot
 * strand a running remote shell without one, then binds the pane. Supersession is fenced on the
 * pane's binding, so under this real order it bailed on the predecessor every time and never re-ran,
 * and each reconnect left one more reattachable lease for `reattachKnownPtys` to `pty.attach`.
 */
async function commitSshSpawn(
  store: ReturnType<typeof createStore>,
  args: { relayPtyId: string; leafId: string }
): Promise<void> {
  const deps = { store } as unknown as PtySpawnIpcDeps
  const spawnArgs = {
    cols: 80,
    rows: 24,
    worktreeId: WORKTREE,
    tabId: TAB,
    leafId: args.leafId,
    connectionId: TARGET
  } as unknown as PtySpawnIpcArgs
  const ctx = createPtyIpcSpawnState(deps, spawnArgs)
  ctx.result = { id: toAppSshPtyId(TARGET, args.relayPtyId) }
  ctx.validatedLeafId = args.leafId
  await persistPtyIpcSpawnCommit(ctx)
}

/** One pane's layout, so the two host partitions can be given different bindings for one leaf. */
function sessionBinding(ptyId: string) {
  return {
    activeRepoId: 'repo1',
    activeWorktreeId: WORKTREE,
    activeTabId: TAB,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {
      [TAB]: {
        root: { type: 'leaf' as const, leafId: TEST_LEAF_1 },
        activeLeafId: TEST_LEAF_1,
        expandedLeafId: null,
        ptyIdsByLeafId: { [TEST_LEAF_1]: ptyId }
      }
    }
  }
}

function bulkReattachPtyIds(store: ReturnType<typeof createStore>): string[] {
  return store
    .getSshRemotePtyLeases(TARGET)
    .filter(sshRemotePtyLeaseAllowsReattach)
    .map((lease) => lease.ptyId)
    .sort()
}

describe('the IPC spawn commit keeps one reattachable lease per SSH pane', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
  })
  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  // QA's measurement, driven through the real path: five relay restarts, one pane, N+1 leases.
  it('holds the reattach set flat across five reconnects of one pane', async () => {
    const store = await createStore()

    for (let reconnect = 0; reconnect < 5; reconnect++) {
      // A relay renumbers from `pty-1` on every start; a reconnect therefore re-leases the same
      // pane under an id it has never used before.
      await commitSshSpawn(store, { relayPtyId: `pty-${reconnect}`, leafId: TEST_LEAF_1 })
    }

    expect(bulkReattachPtyIds(store)).toEqual(['pty-4'])
  })

  it('retires each predecessor as `expired` with the winner recorded, never `terminated`', async () => {
    const store = await createStore()

    await commitSshSpawn(store, { relayPtyId: 'pty-0', leafId: TEST_LEAF_1 })
    await commitSshSpawn(store, { relayPtyId: 'pty-1', leafId: TEST_LEAF_1 })

    const predecessor = store.getSshRemotePtyLeases(TARGET).find((entry) => entry.ptyId === 'pty-0')
    // `expired`, not `terminated`: losing the lease is not evidence the remote shell died, and the
    // process is deliberately left running (docs/reference/ssh-execution-boundary.md).
    expect(predecessor).toMatchObject({ state: 'expired', supersededBy: 'pty-1' })
  })

  // The failure that would be worse than the fan-out: over-superseding strands a live remote
  // process behind a pane that can no longer find it.
  it('leaves a genuine orphan reattachable while superseding the pane that re-leased', async () => {
    const store = await createStore()

    await commitSshSpawn(store, { relayPtyId: 'orphan-pty', leafId: TEST_LEAF_2 })
    // The orphan's client lost its route; nothing observed the shell, so it stays askable.
    store.markSshRemotePtyLease(TARGET, 'orphan-pty', 'expired')

    await commitSshSpawn(store, { relayPtyId: 'pty-0', leafId: TEST_LEAF_1 })
    await commitSshSpawn(store, { relayPtyId: 'pty-1', leafId: TEST_LEAF_1 })

    const orphan = store.getSshRemotePtyLeases(TARGET).find((entry) => entry.ptyId === 'orphan-pty')
    expect(orphan?.supersededBy).toBeUndefined()
    expect(bulkReattachPtyIds(store)).toEqual(['orphan-pty', 'pty-1'])
  })

  /**
   * The shape the Docker lane exposed, and the reason a spawn-time trigger is not enough on its
   * own. When the spawn commit writes no binding, the renderer's debounced layout publish does it
   * later — so at commit time the pane still names the predecessor and supersession correctly
   * declines. Nothing revisited it afterwards, and the predecessor stayed reattachable forever.
   *
   * Measured rows agreed on target, worktree, tab and leaf and still carried no `supersededBy`.
   */
  it('retires a predecessor whose successor bound the pane after the spawn commit', async () => {
    const store = await createStore()

    await commitSshSpawn(store, { relayPtyId: 'pty2:aaa:1', leafId: TEST_LEAF_1 })
    // What `handlePtyReattachFailure` writes when a restarted relay disowns the id.
    store.markSshRemotePtyLease(TARGET, 'pty2:aaa:1', 'expired')

    // The successor leases without binding the pane; the binding catches up afterwards, exactly as
    // the renderer's debounced publish does.
    store.upsertSshRemotePtyLease({
      targetId: TARGET,
      ptyId: 'pty2:bbb:1',
      worktreeId: WORKTREE,
      tabId: TAB,
      leafId: TEST_LEAF_1,
      state: 'attached'
    })
    expect(bulkReattachPtyIds(store)).toEqual(['pty2:aaa:1', 'pty2:bbb:1'])
    store.persistPtyBinding({
      worktreeId: WORKTREE,
      tabId: TAB,
      leafId: TEST_LEAF_1,
      ptyId: toAppSshPtyId(TARGET, 'pty2:bbb:1')
    })

    // What the connect path does before reading the set it feeds to `pty.attach`.
    store.reconcileSshRemotePtyLeasesForTarget(TARGET)

    expect(bulkReattachPtyIds(store)).toEqual(['pty2:bbb:1'])
  })

  // Reconciliation must not invent evidence: with no binding naming the pane, nothing says which
  // shell owns it, so every lease stays askable.
  it('leaves leases reattachable when no binding names the pane', async () => {
    const store = await createStore()

    store.upsertSshRemotePtyLease({
      targetId: TARGET,
      ptyId: 'unbound-a',
      worktreeId: WORKTREE,
      tabId: TAB,
      leafId: TEST_LEAF_1,
      state: 'expired'
    })
    store.upsertSshRemotePtyLease({
      targetId: TARGET,
      ptyId: 'unbound-b',
      worktreeId: WORKTREE,
      tabId: TAB,
      leafId: TEST_LEAF_1,
      state: 'expired'
    })

    store.reconcileSshRemotePtyLeasesForTarget(TARGET)

    expect(bulkReattachPtyIds(store)).toEqual(['unbound-a', 'unbound-b'])
  })

  /**
   * The measured defect, reduced to its cause.
   *
   * Main writes an SSH pane's binding to the `ssh:<target>` partition, but a stale copy of the same
   * leaf survives in `local`. Reading `local` first named the PREDECESSOR as the pane's current
   * PTY, so supersession took an already-expired lease as its winner and returned having marked
   * nothing — once per relay restart, forever. Both partitions name the same PTY again once the
   * renderer republishes, which is why the finished store looks consistent and hides this.
   */
  it('supersedes when the local partition still names the predecessor', async () => {
    const store = await createStore()
    const hostId = toSshExecutionHostId(TARGET)
    const predecessor = toAppSshPtyId(TARGET, 'pty2:old:1')
    const successor = toAppSshPtyId(TARGET, 'pty2:new:1')

    store.upsertSshRemotePtyLease({
      targetId: TARGET,
      ptyId: 'pty2:old:1',
      worktreeId: WORKTREE,
      tabId: TAB,
      leafId: TEST_LEAF_1,
      state: 'expired'
    })
    // Both partitions start on the predecessor, as they do before a relay restart.
    store.setWorkspaceSession(sessionBinding(predecessor))
    store.setWorkspaceSession(sessionBinding(predecessor), hostId)
    store.upsertSshRemotePtyLease({
      targetId: TARGET,
      ptyId: 'pty2:new:1',
      worktreeId: WORKTREE,
      tabId: TAB,
      leafId: TEST_LEAF_1,
      state: 'attached'
    })
    // Production's writer for an SSH pane binding, and the whole point: it updates ONLY the host
    // partition, so `local` is left naming the predecessor until the renderer republishes.
    store.persistPtyBinding(
      { worktreeId: WORKTREE, tabId: TAB, leafId: TEST_LEAF_1, ptyId: successor },
      hostId
    )
    expect(
      store.getWorkspaceSession().terminalLayoutsByTabId?.[TAB]?.ptyIdsByLeafId?.[TEST_LEAF_1]
    ).toBe(predecessor)

    store.supersedeSshRemotePtyLeasesForBoundPane(TARGET, TEST_LEAF_1)

    const retired = store.getSshRemotePtyLeases(TARGET).find((l) => l.ptyId === 'pty2:old:1')
    expect(retired).toMatchObject({ state: 'expired', supersededBy: 'pty2:new:1' })
    expect(bulkReattachPtyIds(store)).toEqual(['pty2:new:1'])
  })

  // The mirror: a live shell the pane is still bound to must never be retired, whichever partition
  // names it. Over-superseding strands a running remote process.
  it('never retires a live lease the pane is still bound to', async () => {
    const store = await createStore()
    const live = toAppSshPtyId(TARGET, 'pty2:live:1')

    store.upsertSshRemotePtyLease({
      targetId: TARGET,
      ptyId: 'pty2:live:1',
      worktreeId: WORKTREE,
      tabId: TAB,
      leafId: TEST_LEAF_1,
      state: 'attached'
    })
    // Bound BEFORE the stray lease arrives, which is the order that makes the binding meaningful:
    // with no binding at all, an arriving lease is the only evidence there is and does win.
    store.setWorkspaceSession(sessionBinding(live))
    store.setWorkspaceSession(sessionBinding(live), toSshExecutionHostId(TARGET))
    store.upsertSshRemotePtyLease({
      targetId: TARGET,
      ptyId: 'pty2:other:1',
      worktreeId: WORKTREE,
      tabId: TAB,
      leafId: TEST_LEAF_1,
      state: 'attached'
    })

    store.supersedeSshRemotePtyLeasesForBoundPane(TARGET, TEST_LEAF_1)

    const stillLive = store.getSshRemotePtyLeases(TARGET).find((l) => l.ptyId === 'pty2:live:1')
    expect(stillLive).toMatchObject({ state: 'attached' })
    expect(stillLive?.supersededBy).toBeUndefined()
  })

  // Panes are independent, and supersession keys on the leaf: a second live pane on the same
  // target must survive its neighbour reconnecting.
  it('does not touch a sibling pane on the same target', async () => {
    const store = await createStore()

    await commitSshSpawn(store, { relayPtyId: 'sibling-pty', leafId: TEST_LEAF_2 })
    await commitSshSpawn(store, { relayPtyId: 'pty-0', leafId: TEST_LEAF_1 })
    await commitSshSpawn(store, { relayPtyId: 'pty-1', leafId: TEST_LEAF_1 })

    expect(bulkReattachPtyIds(store)).toEqual(['pty-1', 'sibling-pty'])
  })
})
