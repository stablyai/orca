import { describe, expect, it, vi } from 'vitest'
import { SESSION_TABS_TERMINAL_EXIT_STATE_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'
import type { TerminalExitRecord } from '../../shared/terminal-surface-exit'
import { dropRetirementProofsForLiveSurfaces } from '../../shared/terminal-retirement-proof-ledger'
import { projectSessionTabsForClient } from './rpc/methods/session-tabs-inventory'

const { OrcaRuntimeService } = await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const { store, TEST_WORKTREE_ID, HEADLESS_LEAF_ID } =
  await import('./orca-runtime-test-fixtures.spec')
const { makePendingAgentTabActivationRuntime } =
  await import('./orca-runtime-test-scenario-builders.spec')

type Runtime = InstanceType<typeof OrcaRuntimeService>

const TAB_ID = 'desk-tab'
const SIBLING_LEAF_ID = '22222222-2222-4222-8222-222222222222'
const DEAD_PTY_ID = 'pty-dead'

function exitRecord(overrides: Partial<TerminalExitRecord> = {}): TerminalExitRecord {
  return {
    worktreeId: TEST_WORKTREE_ID,
    leafId: HEADLESS_LEAF_ID,
    ptyId: DEAD_PTY_ID,
    incarnationId: 'inc-dead',
    terminal: 'term_dead',
    exitCode: 3,
    cause: { kind: 'exited', exitCode: 3 },
    exitedAt: 1_700_000_000_000,
    ...overrides
  }
}

function rendererSnapshot(
  leaves: { tabId: string; leafId: string; ptyId?: string }[]
): RuntimeMobileSessionTabsSnapshot {
  return {
    worktree: TEST_WORKTREE_ID,
    publicationEpoch: 'renderer-exit-record',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: `${leaves[0]!.tabId}::${leaves[0]!.leafId}`,
    activeTabType: 'terminal',
    tabs: leaves.map((leaf, index) => ({
      type: 'terminal' as const,
      id: `${leaf.tabId}::${leaf.leafId}`,
      parentTabId: leaf.tabId,
      leafId: leaf.leafId,
      ...(leaf.ptyId ? { ptyId: leaf.ptyId } : {}),
      title: 'Terminal',
      isActive: index === 0
    }))
  }
}

function makeRendererRuntime(snapshot: RuntimeMobileSessionTabsSnapshot) {
  const runtime = new OrcaRuntimeService(store)
  const spawn = vi.fn().mockResolvedValue({ id: 'pty-runtime-spawn' })
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    listProcesses: async () => []
  })
  const notifier = {
    worktreesChanged: vi.fn(),
    reposChanged: vi.fn(),
    activateWorktree: vi.fn(),
    createTerminal: vi.fn(),
    splitTerminal: vi.fn(),
    renameTerminal: vi.fn(),
    focusTerminal: vi.fn(),
    closeTerminal: vi.fn(),
    sleepWorktree: vi.fn(),
    terminalFitOverrideChanged: vi.fn(),
    terminalDriverChanged: vi.fn(),
    restartExitedTerminal: vi.fn(),
    terminalExitRecordsChanged: vi.fn()
  }
  runtime.setNotifier(notifier)
  runtime.syncWindowGraph(0, { tabs: [], leaves: [], mobileSessionTabs: [snapshot] })
  return { runtime, spawn, notifier }
}

async function listForClient(
  runtime: Runtime,
  capabilities: string[]
): Promise<RuntimeMobileSessionTabsResult> {
  return projectSessionTabsForClient(
    await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`),
    'runtime',
    capabilities,
    false
  )
}

describe('terminal exit records', () => {
  it('publishes a kept leaf as exited only to a client that negotiated the capability', async () => {
    const { runtime, notifier } = makeRendererRuntime(
      rendererSnapshot([{ tabId: TAB_ID, leafId: HEADLESS_LEAF_ID }])
    )
    runtime.terminalExitRecords.record(exitRecord())

    expect(notifier.terminalExitRecordsChanged).toHaveBeenLastCalledWith([exitRecord()])
    const capable = await listForClient(runtime, [
      SESSION_TABS_TERMINAL_EXIT_STATE_RUNTIME_CAPABILITY
    ])
    expect(capable.tabs).toEqual([
      expect.objectContaining({
        leafId: HEADLESS_LEAF_ID,
        status: 'pending-handle',
        exited: {
          ptyId: DEAD_PTY_ID,
          incarnationId: 'inc-dead',
          terminal: 'term_dead',
          exitCode: 3,
          cause: { kind: 'exited', exitCode: 3 },
          exitedAt: 1_700_000_000_000
        }
      })
    ])

    // Why: an older client reads a handle-less leaf as a terminal still starting and waits forever.
    const old = await listForClient(runtime, [])
    expect(old.tabs).toEqual([])
    expect(old.snapshotVersion).toBe(capable.snapshotVersion)
    expect(old.retiredTerminalSurfaces).toEqual([
      {
        parentTabId: TAB_ID,
        leafId: HEADLESS_LEAF_ID,
        ptyId: DEAD_PTY_ID,
        terminal: 'term_dead',
        incarnationId: 'inc-dead'
      }
    ])
  })

  it('retires only the exited leaf of a split for an older client', async () => {
    const { runtime } = makeRendererRuntime(
      rendererSnapshot([
        { tabId: TAB_ID, leafId: HEADLESS_LEAF_ID },
        { tabId: TAB_ID, leafId: SIBLING_LEAF_ID, ptyId: 'pty-sibling' }
      ])
    )
    runtime.terminalExitRecords.record(exitRecord())

    const old = await listForClient(runtime, [])

    expect(old.tabs.map((tab) => (tab.type === 'terminal' ? tab.leafId : tab.id))).toEqual([
      SIBLING_LEAF_ID
    ])
  })

  it('keeps the record with the leaf when the pane moves to another tab', async () => {
    const { runtime } = makeRendererRuntime(
      rendererSnapshot([{ tabId: TAB_ID, leafId: HEADLESS_LEAF_ID }])
    )
    runtime.terminalExitRecords.record(exitRecord())
    runtime.syncWindowGraph(0, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          ...rendererSnapshot([{ tabId: 'moved-tab', leafId: HEADLESS_LEAF_ID }]),
          snapshotVersion: 5
        }
      ]
    })

    const capable = await listForClient(runtime, [
      SESSION_TABS_TERMINAL_EXIT_STATE_RUNTIME_CAPABILITY
    ])

    expect(capable.tabs).toEqual([
      expect.objectContaining({
        parentTabId: 'moved-tab',
        exited: expect.objectContaining({ ptyId: DEAD_PTY_ID })
      })
    ])
  })

  it('ends the record when the leaf binds its next process, and an older client sees it again', async () => {
    const { runtime, notifier } = makeRendererRuntime(
      rendererSnapshot([{ tabId: TAB_ID, leafId: HEADLESS_LEAF_ID }])
    )
    runtime.terminalExitRecords.record(exitRecord())
    const retiredFrame = await listForClient(runtime, [])

    // The exited process registering again is not a restart.
    runtime.registerPty(DEAD_PTY_ID, TEST_WORKTREE_ID, null, {
      tabId: TAB_ID,
      leafId: HEADLESS_LEAF_ID,
      incarnationId: 'inc-dead'
    })
    expect(runtime.terminalExitRecords.get(HEADLESS_LEAF_ID)).toBeDefined()

    runtime.registerPty('pty-restarted', TEST_WORKTREE_ID, null, {
      tabId: TAB_ID,
      leafId: HEADLESS_LEAF_ID,
      incarnationId: 'inc-restarted'
    })

    expect(runtime.terminalExitRecords.get(HEADLESS_LEAF_ID)).toBeUndefined()
    expect(notifier.terminalExitRecordsChanged).toHaveBeenLastCalledWith([])
    const live = await listForClient(runtime, [])
    expect(live.tabs).toEqual([expect.objectContaining({ leafId: HEADLESS_LEAF_ID })])
    // The client ledger drops a proof once its surface is published live again.
    expect(
      dropRetirementProofsForLiveSurfaces(retiredFrame.retiredTerminalSurfaces ?? [], live.tabs)
    ).toEqual([])
  })

  it('ends the record when the surface is closed', () => {
    const { runtime } = makePendingAgentTabActivationRuntime()
    runtime.terminalExitRecords.record(exitRecord({ ptyId: 'serve-dead-pty' }))

    runtime.closeTerminalSurfaceFromRenderer({ worktreeId: TEST_WORKTREE_ID, tabId: 'host-tab' })

    expect(runtime.terminalExitRecords.get(HEADLESS_LEAF_ID)).toBeUndefined()
  })

  it('routes a user activation of a desktop-held exited leaf to the desktop pane', async () => {
    const { runtime, spawn, notifier } = makeRendererRuntime(
      rendererSnapshot([{ tabId: TAB_ID, leafId: HEADLESS_LEAF_ID }])
    )
    runtime.terminalExitRecords.record(exitRecord())

    await runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, TAB_ID, HEADLESS_LEAF_ID, {
      notifyClients: false,
      intent: 'user'
    })

    expect(notifier.restartExitedTerminal).toHaveBeenCalledWith(
      TAB_ID,
      TEST_WORKTREE_ID,
      HEADLESS_LEAF_ID
    )
    expect(notifier.focusTerminal).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('never restarts or focuses an exited leaf for an automatic probe', async () => {
    const { runtime, spawn, notifier } = makeRendererRuntime(
      rendererSnapshot([{ tabId: TAB_ID, leafId: HEADLESS_LEAF_ID }])
    )
    runtime.terminalExitRecords.record(exitRecord())

    await runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, TAB_ID, HEADLESS_LEAF_ID, {
      intent: 'automatic'
    })

    expect(notifier.restartExitedTerminal).not.toHaveBeenCalled()
    expect(notifier.focusTerminal).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('restarts a headless exited agent tab as a plain shell, never through materialize', async () => {
    const { runtime, spawn } = makePendingAgentTabActivationRuntime()
    runtime.terminalExitRecords.record(exitRecord({ ptyId: 'serve-dead-pty' }))

    await runtime.activateMobileSessionTab(
      `id:${TEST_WORKTREE_ID}`,
      `host-tab::${HEADLESS_LEAF_ID}`,
      undefined,
      { notifyClients: false, intent: 'user' }
    )

    expect(spawn).toHaveBeenCalledTimes(1)
    const request = spawn.mock.calls[0]![0]
    expect(request).toMatchObject({ tabId: 'host-tab', leafId: HEADLESS_LEAF_ID })
    expect(request.command).toBeUndefined()
    // Why: materialize reattaches the tab's recorded session and relaunches its agent.
    expect(request.sessionId).not.toBe('serve-dead-pty')
    expect(runtime.terminalExitRecords.get(HEADLESS_LEAF_ID)).toBeUndefined()
  })
})
