import { describe, expect, it, vi } from 'vitest'
import { movePaneFirst, registerBoundPty } from '../bind-first-pane.test-fixture'
import {
  HEADLESS_LEAF_ID,
  TEST_WINDOW_ID,
  TEST_WORKTREE_ID,
  createRuntime,
  createRuntimeWithSshLease,
  store
} from '../orca-runtime-test-fixtures.spec'
import { makePaneKey, OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import type { SshRemotePtyLease } from '../../../shared/ssh-types'

describe('OrcaRuntimeService', () => {
  it('keeps a no-incarnation handle across an in-graph pane remint', async () => {
    const runtime = createRuntime()
    const tabId = 'tab-1'
    // No preallocated handle or incarnation id: the live PTY itself is the continuity proof within this graph.
    runtime.attachWindow(TEST_WINDOW_ID)
    runtime.syncWindowGraph(TEST_WINDOW_ID, {
      tabs: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          title: 'Shell',
          activeLeafId: 'leaf-old',
          layout: null
        }
      ],
      leaves: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'leaf-old',
          paneRuntimeId: 1,
          ptyId: 'pty-plain'
        }
      ]
    })
    const before = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)
    expect(before.terminals).toHaveLength(1)
    const stableHandle = before.terminals[0].handle
    const waiting = runtime.waitForTerminal(stableHandle, { condition: 'exit', timeoutMs: 30_000 })

    runtime.syncWindowGraph(TEST_WINDOW_ID, {
      tabs: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          title: 'Shell',
          activeLeafId: 'leaf-new',
          layout: null
        }
      ],
      leaves: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'leaf-new',
          paneRuntimeId: 2,
          ptyId: 'pty-plain'
        }
      ]
    })

    const after = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)
    expect(after.terminals).toHaveLength(1)
    expect(after.terminals[0].handle).toBe(stableHandle)
    runtime.onPtyExit('pty-plain', 0)
    await expect(waiting).resolves.toMatchObject({ handle: stableHandle, status: 'exited' })
  })

  it('keeps a live CLI waiter pending when a re-keyed shared handle transfers to the live leaf', async () => {
    const runtime = createRuntime()
    const tabId = 'tab-1'
    // Re-keying a shared PTY handle must preserve its in-flight waiter.
    runtime.preAllocateHandleForPty('pty-agent')
    runtime.attachWindow(TEST_WINDOW_ID)
    runtime.syncWindowGraph(TEST_WINDOW_ID, {
      tabs: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          title: 'Claude',
          activeLeafId: 'leaf-old',
          layout: null
        }
      ],
      leaves: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'leaf-old',
          paneRuntimeId: 1,
          ptyId: 'pty-agent'
        }
      ]
    })
    const before = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)
    const sharedHandle = before.terminals[0].handle
    const abort = new AbortController()
    let settled: 'resolved' | 'rejected' | null = null
    const waiting = runtime
      .waitForTerminal(sharedHandle, {
        condition: 'exit',
        timeoutMs: 30_000,
        signal: abort.signal
      })
      .then(
        () => {
          settled = 'resolved'
        },
        () => {
          settled = 'rejected'
        }
      )

    runtime.syncWindowGraph(TEST_WINDOW_ID, {
      tabs: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          title: 'Claude',
          activeLeafId: 'leaf-new',
          layout: null
        }
      ],
      leaves: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'leaf-new',
          paneRuntimeId: 2,
          ptyId: 'pty-agent'
        }
      ]
    })

    // Let any synchronous stale-handle rejection propagate.
    await new Promise<void>((resolve) => setImmediate(resolve))
    // The transferred shared handle must keep its CLI waiter pending.
    expect(settled).toBeNull()
    await expect(runtime.showTerminal(sharedHandle)).resolves.toMatchObject({
      ptyId: 'pty-agent'
    })

    abort.abort()
    await waiting
    expect(settled).toBe('rejected')
  })
  it('recovers a moved SSH pane through the tab it now sits in, not the one its lease froze', async () => {
    // A moved pane's current coordinates override the lease's frozen old tabId.
    const leaseTabId = 'tab-before-move'
    const currentTabId = 'tab-after-move'
    const appPtyId = 'ssh:ssh-target@@pty-8'
    const runtime = createRuntimeWithSshLease(appPtyId, leaseTabId)
    const paneKey = makePaneKey(currentTabId, HEADLESS_LEAF_ID)
    registerBoundPty(runtime, appPtyId, TEST_WORKTREE_ID, 'ssh-target', {
      tabId: currentTabId,
      leafId: HEADLESS_LEAF_ID
    })
    const handle = runtime.resolveTerminalPane(paneKey, TEST_WORKTREE_ID).handle
    runtime.onPtyExit(appPtyId, -1, undefined, { hostExitConfirmed: true })
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
      handle: 'term-replacement',
      tabId: currentTabId,
      paneKey,
      ptyId: 'pty-replacement',
      worktreeId: TEST_WORKTREE_ID,
      title: null,
      surface: 'background'
    })

    await expect(
      runtime.recoverTerminalPane(paneKey, TEST_WORKTREE_ID, handle)
    ).resolves.toMatchObject({ handle: 'term-replacement' })
    expect(createTerminal).toHaveBeenCalledWith(`id:${TEST_WORKTREE_ID}`, {
      tabId: currentTabId,
      leafId: HEADLESS_LEAF_ID,
      focus: false
    })
  })

  it('refuses a moved SSH pane addressed through the tab it left', async () => {
    // Old-tab coordinates must refuse the moved leaf; otherwise one PTY binds into two tabs.
    const leaseTabId = 'tab-stale-mirror'
    const currentTabId = 'tab-moved-to'
    const appPtyId = 'ssh:ssh-target@@pty-9'
    const runtime = createRuntimeWithSshLease(appPtyId, leaseTabId)
    const stalePaneKey = makePaneKey(leaseTabId, HEADLESS_LEAF_ID)
    registerBoundPty(runtime, appPtyId, TEST_WORKTREE_ID, 'ssh-target', {
      tabId: leaseTabId,
      leafId: HEADLESS_LEAF_ID
    })
    const staleHandle = runtime.resolveTerminalPane(stalePaneKey, TEST_WORKTREE_ID).handle
    movePaneFirst(runtime, leaseTabId, {
      worktreeId: TEST_WORKTREE_ID,
      tabId: currentTabId,
      leafId: HEADLESS_LEAF_ID,
      ptyId: appPtyId
    })
    runtime.registerPty(appPtyId, TEST_WORKTREE_ID, 'ssh-target', {
      tabId: currentTabId,
      leafId: HEADLESS_LEAF_ID
    })
    runtime.onPtyExit(appPtyId, -1, undefined, { hostExitConfirmed: true })
    const createTerminal = vi.spyOn(runtime, 'createTerminal')

    await expect(
      runtime.recoverTerminalPane(stalePaneKey, TEST_WORKTREE_ID, staleHandle)
    ).rejects.toThrow(/terminal_not_recoverable|terminal_not_found/)
    const leases = runtime as unknown as {
      getRecentExpiredSshLease: (worktreeId: string, tabId: string, leafId?: string) => unknown
    }
    expect(
      leases.getRecentExpiredSshLease(TEST_WORKTREE_ID, leaseTabId, HEADLESS_LEAF_ID)
    ).toBeNull()
    expect(
      leases.getRecentExpiredSshLease(TEST_WORKTREE_ID, currentTabId, HEADLESS_LEAF_ID)
    ).not.toBeNull()
    expect(createTerminal).not.toHaveBeenCalled()
  })
})

// Several leases can share pane coordinates; select an eligible orphan rather than the first match.

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
  }
}

function readerWithLeases(leases: SshRemotePtyLease[]): LeaseReader {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The runtime implements these protected lease readers.
  return new OrcaRuntimeService({
    ...store,
    getSshRemotePtyLeases: () => leases
  }) as unknown as LeaseReader
}

const pane = { parentTabId: TAB_ID, leafId: HEADLESS_LEAF_ID }

describe('recent expired SSH lease candidacy', () => {
  it('reports a plain expired orphan', () => {
    const reader = readerWithLeases([leaseFor('pty-1')])

    expect(reader.hasRecentExpiredSshLeasePane(TEST_WORKTREE_ID, pane)).toBe(true)
  })

  it('does not report a pane whose only recent lease was superseded', () => {
    // A superseded lease no longer routes to its original shell and cannot offer recovery.
    const reader = readerWithLeases([leaseFor('pty-1', { supersededBy: 'pty-2' })])

    expect(reader.hasRecentExpiredSshLeasePane(TEST_WORKTREE_ID, pane)).toBe(false)
  })

  it('does not report a pane whose only recent lease had its relay id recycled', () => {
    // A recycled relay id belongs to another shell and must never be adopted.
    const reader = readerWithLeases([leaseFor('pty-1', { relayIdRecycled: true })])

    expect(reader.hasRecentExpiredSshLeasePane(TEST_WORKTREE_ID, pane)).toBe(false)
  })

  it('picks the eligible orphan over a superseded predecessor that matches first', () => {
    // Store the superseded lease first to catch first-match recovery.
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
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The runtime implements these protected lease readers.
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
