import { describe, expect, it } from 'vitest'
import { HEADLESS_LEAF_ID, TEST_WORKTREE_ID, store } from './orca-runtime-test-fixtures.spec'
import { OrcaRuntimeService } from './orca-runtime'
import type { SshRemotePtyLease } from '../../shared/ssh-types'

// Which `expired` SSH leases may answer "this pane is still recoverable". A pane accumulates leases
// as it re-leases under new relay ids, so the pane coordinates alone name several and the reader
// has to pick the ELIGIBLE orphan rather than the first id match. Lives in a `*.test.ts` because
// config/vitest.config.ts — the config CI runs — includes only `*.test.ts`.

const TARGET = 'ssh-target'
const TAB_ID = 'tab-candidacy'

type LeaseReader = {
  workspaceSessionWorktreeHasRuntimeOwnedPtyCandidate: (
    session: { terminalLayoutsByTabId?: Record<string, unknown> },
    worktreeId: string,
    tabs: { id: string; ptyId: string | null }[]
  ) => boolean
  collectRecentExpiredSshLeaseTabIds: (worktreeId: string) => ReadonlySet<string>
  getRecentExpiredSshLease: (
    worktreeId: string,
    tabId: string,
    leafId: string | undefined,
    ptyId?: string
  ) => SshRemotePtyLease | null
  hasRecentExpiredSshLeasePane: (
    worktreeId: string,
    tab: { parentTabId: string; leafId: string }
  ) => boolean
}

function leaseFor(ptyId: string, marks: Partial<SshRemotePtyLease> = {}): SshRemotePtyLease {
  const now = Date.now()
  return {
    targetId: TARGET,
    ptyId,
    worktreeId: TEST_WORKTREE_ID,
    tabId: TAB_ID,
    leafId: HEADLESS_LEAF_ID,
    state: 'expired',
    createdAt: now,
    updatedAt: now,
    ...marks
  } as SshRemotePtyLease
}

function readerWithLeases(leases: SshRemotePtyLease[]): LeaseReader {
  return new OrcaRuntimeService({
    ...store,
    getSshRemotePtyLeases: () => leases
  }) as unknown as LeaseReader
}

const pane = { parentTabId: TAB_ID, leafId: HEADLESS_LEAF_ID }

describe('recent expired SSH lease candidacy', () => {
  it('reports a plain expired orphan', () => {
    // Control: `expired` carrying no retirement mark is an orphan whose reattach merely lost
    // contact, which is exactly what the recovery affordance exists for.
    const reader = readerWithLeases([leaseFor('pty-1')])

    expect(reader.hasRecentExpiredSshLeasePane(TEST_WORKTREE_ID, pane)).toBe(true)
  })

  it('does not report a pane whose only recent lease was superseded', () => {
    // `supersededBy` names the lease that won this pane, so the id no longer routes to the shell
    // this lease describes. `recoverTerminalPane` refuses it, so reporting it here offers a paired
    // viewer a recovery that cannot succeed.
    const reader = readerWithLeases([leaseFor('pty-1', { supersededBy: 'pty-2' })])

    expect(reader.hasRecentExpiredSshLeasePane(TEST_WORKTREE_ID, pane)).toBe(false)
  })

  it('does not report a pane whose only recent lease had its relay id recycled', () => {
    // Same shape, other mark: the relay handed this id to a different shell, so adopting through
    // it would hand the pane a stranger's process.
    const reader = readerWithLeases([leaseFor('pty-1', { relayIdRecycled: true })])

    expect(reader.hasRecentExpiredSshLeasePane(TEST_WORKTREE_ID, pane)).toBe(false)
  })

  it('picks the eligible orphan over a superseded predecessor that matches first', () => {
    // The pane's coordinates name both leases and the predecessor is stored first, so a reader
    // that took the first match would answer with the one lease that cannot be reattached.
    const reader = readerWithLeases([
      leaseFor('pty-1', { supersededBy: 'pty-2' }),
      leaseFor('pty-2')
    ])

    expect(reader.getRecentExpiredSshLease(TEST_WORKTREE_ID, TAB_ID, HEADLESS_LEAF_ID)?.ptyId).toBe(
      'pty-2'
    )
    expect(reader.hasRecentExpiredSshLeasePane(TEST_WORKTREE_ID, pane)).toBe(true)
  })

  it('collects the same tabs the per-tab reader reports, in one sweep of the leases', () => {
    const leases = [leaseFor('pty-1', { supersededBy: 'pty-2' }), leaseFor('pty-2')]
    let sweeps = 0
    const reader = new OrcaRuntimeService({
      ...store,
      getSshRemotePtyLeases: () => {
        sweeps += 1
        return leases
      }
    }) as unknown as LeaseReader
    const tabs = Array.from({ length: 8 }, (_, index) => ({
      id: index === 7 ? TAB_ID : `tab-${index}`,
      ptyId: null
    }))

    expect(
      reader.workspaceSessionWorktreeHasRuntimeOwnedPtyCandidate(
        { terminalLayoutsByTabId: {} },
        TEST_WORKTREE_ID,
        tabs
      )
    ).toBe(true)
    // One sweep answers all eight tabs; the per-tab reader used to sweep once per tab.
    expect(sweeps).toBe(1)
    expect([...reader.collectRecentExpiredSshLeaseTabIds(TEST_WORKTREE_ID)]).toEqual([TAB_ID])
  })

  it('reports no candidate when no lease names any of the worktree tabs', () => {
    const reader = readerWithLeases([
      leaseFor('pty-1', { tabId: 'somewhere-else', leafId: undefined })
    ])

    expect(
      reader.workspaceSessionWorktreeHasRuntimeOwnedPtyCandidate(
        { terminalLayoutsByTabId: {} },
        TEST_WORKTREE_ID,
        [{ id: TAB_ID, ptyId: null }]
      )
    ).toBe(false)
  })
})
