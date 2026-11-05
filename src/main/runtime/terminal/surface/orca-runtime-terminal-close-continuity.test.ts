import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'

import {
  resetAgentLaunchPanesForTests,
  trackRunningAgentLaunchPane
} from '../../../agent-launch/agent-launch-pane-attachment'
import {
  CANARY_INCARNATION_ID,
  CANARY_LEAF_ID,
  CANARY_PTY_ID,
  CANARY_TAB_ID,
  INCARNATION_ID,
  LEAF_ID,
  PTY_ID,
  RUNTIME_OWNED_PTY_ID,
  SIBLING_INCARNATION_ID,
  SIBLING_LEAF_ID,
  TAB_ID,
  WORKTREE_ID
} from '../../__fixtures__/orca-runtime-terminal-close-continuity-state-fixture'
import {
  createHarness,
  createStaleTabCloseHarness
} from '../../__fixtures__/orca-runtime-terminal-close-continuity-fixtures'
import { expectDesktopDropsPane } from '../../__fixtures__/main-layout-close-fixture'
import type { CloseContinuityHarness } from '../../__fixtures__/orca-runtime-terminal-close-continuity-fixtures'

/** Last-pane close retires the tab: legacy renderer acknowledges, main-owned layout persists before stopping. */
async function closeLastPane(
  harness: CloseContinuityHarness,
  handle: string
): Promise<Awaited<ReturnType<CloseContinuityHarness['runtime']['closeTerminal']>>> {
  if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
    const closing = harness.runtime.closeTerminal(handle)
    await vi.waitFor(() => expect(harness.closeTerminalTab).toHaveBeenCalled())
    expect(harness.stopAndWait).not.toHaveBeenCalled()
    expect(harness.kill).not.toHaveBeenCalled()
    harness.retirePersistedTab()
    harness.acknowledged.resolve()
    return closing
  }
  let tabsAtStop: unknown = 'not stopped'
  harness.setStopAndWaitAction(() => {
    tabsAtStop = harness.getSession().tabsByWorktree[WORKTREE_ID]
  })
  const close = await harness.runtime.closeTerminal(handle)
  expect(harness.closeTerminalTab).not.toHaveBeenCalled()
  expect(harness.getSession().tabsByWorktree[WORKTREE_ID]).toEqual([])
  if (harness.stopAndWait.mock.calls.length > 0) {
    expect(tabsAtStop).toEqual([])
    expect(harness.flushOrThrow.mock.invocationCallOrder[0]).toBeLessThan(
      harness.stopAndWait.mock.invocationCallOrder[0]!
    )
  }
  return close
}

describe('terminal close and handle incarnation continuity', () => {
  // L259a/b: main-owned close still lacks stale saved/unplaced headless continuity.
  ;(ORCA_LAYOUT_OWNER_IS_MAIN ? it.fails : it).each(['saved', 'unplaced'] as const)(
    'closes a stale headless tab with a %s placement without leaving its terminal behind',
    async (placement) => {
      const harness = await createStaleTabCloseHarness({ headless: true })
      if (placement === 'unplaced') {
        harness.retirePersistedTab()
      }

      await expect(
        harness.runtime.closeTerminalTab(harness.terminal.handle)
      ).resolves.toMatchObject({
        handle: harness.terminal.handle,
        tabId: TAB_ID,
        closeMode: 'tab'
      })

      expect(harness.kill.mock.calls.map(([id]) => id)).toContain(RUNTIME_OWNED_PTY_ID)
      expect(harness.getSession().tabsByWorktree[WORKTREE_ID]).toEqual([])
      await expect(
        harness.runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
      ).resolves.toMatchObject({ tabs: [] })
    }
  )

  it('does not let a colliding PTY id close a different persisted incarnation', async () => {
    const harness = await createStaleTabCloseHarness({ headless: true })
    harness.replacePersistedIncarnation(SIBLING_INCARNATION_ID)
    const { terminal } = harness

    await expect(harness.runtime.closeTerminalTab(terminal.handle)).rejects.toThrow(
      'terminal_handle_stale'
    )

    expect(harness.kill).not.toHaveBeenCalled()
    expect(harness.closeTerminalTab).not.toHaveBeenCalled()
    expect(harness.getSession().tabsByWorktree[WORKTREE_ID]).toHaveLength(1)
  })

  it('does not acknowledge final-pane close before durable tab retirement', async () => {
    const harness = createHarness()
    const [{ handle }] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals
    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      await expect(closeLastPane(harness, handle)).resolves.toMatchObject({
        handle,
        tabId: TAB_ID,
        ptyKilled: false
      })
      expect(harness.flushOrThrow.mock.invocationCallOrder[0]).toBeLessThan(
        harness.kill.mock.invocationCallOrder[0]!
      )
    } else {
      let settled = false
      const closing = harness.runtime.closeTerminal(handle).finally(() => {
        settled = true
      })

      await vi.waitFor(() =>
        expect(harness.closeTerminalTab).toHaveBeenCalledWith(TAB_ID, {
          localPtyTeardownOwnedExternally: true
        })
      )
      expect(settled).toBe(false)
      expect(harness.getSession().tabsByWorktree[WORKTREE_ID]).toHaveLength(1)

      harness.retirePersistedTab()
      harness.acknowledged.resolve()
      await expect(closing).resolves.toMatchObject({ handle, tabId: TAB_ID, ptyKilled: false })
    }
    expect(harness.kill.mock.calls.map(([id]) => id)).toContain(PTY_ID)
    expect(harness.closeTerminal).not.toHaveBeenCalled()
    expect(harness.getSession().tabsByWorktree[WORKTREE_ID]).toEqual([])
  })

  it('fences final-pane exit ordering until exact retirement commits', async () => {
    const harness = createHarness({
      includeCanary: true,
      publishMobileSurface: true,
      registerPtyBacked: true
    })
    harness.syncFixtureTabWithoutLeaf()
    const closeMobileSessionTab = vi.spyOn(harness.runtime, 'closeMobileSessionTab')
    const order: string[] = []
    harness.setCloseTerminalTabAction(() => {
      order.push('session-retirement')
      harness.retirePersistedTab()
      harness.syncCanaryGraph()
      order.push('committed-graph-removal')
    })
    harness.setVerifiedStopResult(true)
    harness.setStopAndWaitAction((stoppingPtyId) => {
      if (ORCA_LAYOUT_OWNER_IS_MAIN) {
        if (!harness.getSession().tabsByWorktree[WORKTREE_ID]?.some((tab) => tab.id === TAB_ID)) {
          order.push('session-retirement')
        }
        if (harness.runtime['paneOfPty']({ ptyId: stoppingPtyId }).tabId === null) {
          order.push('committed-graph-removal')
        }
      }
      order.push('pty-stop')
      harness.removeVictimFromInventory()
      harness.syncCanaryGraph()
      order.push('idempotent-graph-removal')
      harness.runtime.onPtyExit(stoppingPtyId, 0, INCARNATION_ID)
      order.push('idempotent-session-retirement')
    })
    const terminals = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals
    const victim = terminals.find((terminal) => terminal.ptyId === PTY_ID)!
    const canary = terminals.find((terminal) => terminal.ptyId === CANARY_PTY_ID)!

    await expect(harness.runtime.closeTerminal(victim.handle)).resolves.toMatchObject({
      handle: victim.handle,
      tabId: TAB_ID,
      ptyKilled: true
    })

    expect(order).toEqual([
      'session-retirement',
      'committed-graph-removal',
      'pty-stop',
      'idempotent-graph-removal',
      'idempotent-session-retirement'
    ])
    expect(harness.stopAndWait).toHaveBeenCalledTimes(1)
    expect(harness.stopAndWait).toHaveBeenCalledWith(PTY_ID, {
      deadlineMs: expect.any(Number),
      isCurrent: expect.any(Function)
    })
    expect(harness.kill).not.toHaveBeenCalled()
    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      expect(closeMobileSessionTab).not.toHaveBeenCalled()
      expect(harness.closeTerminalTab).not.toHaveBeenCalled()
    } else {
      expect(closeMobileSessionTab).toHaveBeenCalledTimes(1)
      expect(closeMobileSessionTab).toHaveBeenCalledWith(`id:${WORKTREE_ID}`, TAB_ID, {
        localPtyTeardownOwnedExternally: true
      })
      expect(harness.closeTerminalTab).toHaveBeenCalledTimes(1)
    }
    expect(harness.getSession().tabsByWorktree[WORKTREE_ID]).toEqual([
      expect.objectContaining({ id: CANARY_TAB_ID, ptyId: CANARY_PTY_ID })
    ])
    expect(harness.getSession().terminalLayoutsByTabId).toEqual({
      [CANARY_TAB_ID]: expect.objectContaining({
        ptyIdsByLeafId: { [CANARY_LEAF_ID]: CANARY_PTY_ID }
      })
    })
    expect(harness.getSession().terminalPtyIncarnationsByPaneKey).toEqual({
      [makePaneKey(CANARY_TAB_ID, CANARY_LEAF_ID)]: CANARY_INCARNATION_ID
    })
    const survivors = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals
    expect(survivors).toHaveLength(1)
    const [survivor] = survivors
    expect(survivor).toMatchObject({ ptyId: CANARY_PTY_ID })
    await expect(harness.runtime.readTerminal(survivor.handle)).resolves.toMatchObject({
      handle: survivor.handle,
      status: 'running'
    })
    expect(canary.ptyId).toBe(survivor.ptyId)
  })

  it('keeps a handle through an intermediate empty reload graph', async () => {
    const harness = createHarness()
    const [before] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals
    harness.runtime.onPtyData(PTY_ID, '\x1b]0;\u280b Working on task\x07output\n', 100)
    const waiting = harness.runtime.waitForTerminal(before.handle, {
      condition: 'tui-idle',
      timeoutMs: 1_000
    })

    harness.runtime.markRendererReloading(1)
    harness.syncEmptyGraph()
    harness.syncFixtureGraph()
    harness.runtime.onPtyData(PTY_ID, '\x1b]0;\u2733 Task complete\x07done\n', 200)

    const [after] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals
    expect(after.handle).toBe(before.handle)
    await expect(waiting).resolves.toMatchObject({
      handle: before.handle,
      condition: 'tui-idle',
      satisfied: true
    })
    await expect(harness.runtime.readTerminal(before.handle)).resolves.toMatchObject({
      handle: before.handle,
      status: 'running'
    })
  })

  it('stales the old handle when the same PTY id names a new incarnation', async () => {
    const harness = createHarness()
    const [before] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals

    harness.runtime.markRendererReloading(1)
    harness.replaceIncarnation('33333333-3333-4333-8333-333333333333')
    harness.replacePersistedIncarnation('33333333-3333-4333-8333-333333333333')
    harness.syncFixtureGraph()

    const [after] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals
    expect(after.handle).not.toBe(before.handle)
    expect(after.incarnationId).toBe('33333333-3333-4333-8333-333333333333')
    await expect(harness.runtime.readTerminal(before.handle)).rejects.toThrow(
      'terminal_handle_stale'
    )
  })
})

function launchIn(leafId: string) {
  return trackRunningAgentLaunchPane({
    worktreeId: WORKTREE_ID,
    paneKey: makePaneKey(TAB_ID, leafId)
  })
}

describe("a pane close main starts (a phone's, the CLI's)", () => {
  afterEach(() => {
    resetAgentLaunchPanesForTests()
  })

  it('stops a launch still running in that pane, and only that one', async () => {
    const harness = createHarness({ publishMobileSurface: true })
    harness.syncSplitFixtureGraph()
    const closed = launchIn(LEAF_ID)
    const sibling = launchIn(SIBLING_LEAF_ID)
    const terminal = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals.find(
      (candidate) => candidate.ptyId === PTY_ID
    )
    if (!terminal) {
      throw new Error('fixture pane has no terminal handle')
    }

    await harness.runtime.closeTerminal(terminal.handle)

    expectDesktopDropsPane(harness, TAB_ID, LEAF_ID)
    expect(closed.closedByUser()).toBe(true)
    expect(sibling.closedByUser()).toBe(false)
  })
})

/** CLI/headless path: PTY-backed tab without a paired-viewer surface. */
