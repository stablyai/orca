import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'
import { makePaneKey } from '../../shared/stable-pane-id'
import { registerBoundPty } from './bind-first-pane.test-fixture'
import {
  resetAgentLaunchPanesForTests,
  trackRunningAgentLaunchPane
} from '../agent-launch/agent-launch-pane-attachment'
import {
  CANARY_INCARNATION_ID,
  CANARY_LEAF_ID,
  CANARY_PTY_ID,
  CANARY_TAB_ID,
  createHarness,
  createPtyBackedPublishedSurfaceHarness,
  createStaleTabCloseHarness,
  expectDesktopDropsPane,
  INCARNATION_ID,
  LEAF_ID,
  OTHER_WORKTREE_ID,
  PTY_ID,
  RUNTIME_OWNED_PTY_ID,
  SIBLING_INCARNATION_ID,
  SIBLING_LEAF_ID,
  SIBLING_PTY_ID,
  STALE_TAB_ID,
  TAB_ID,
  WORKTREE_ID,
  type CloseContinuityHarness
} from './__fixtures__/orca-runtime-terminal-close-continuity-fixtures'

/**
 * A CLI close of a tab's last pane. Switch-off the renderer's tab close retires the tab, then
 * acknowledges; switch-on it is main's layout close, durable before any stop goes out.
 */
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

/** A refusal of a close the user may not make. Switch-off the renderer's pin guard; switch-on main's. */
function refuseTabClose(harness: CloseContinuityHarness): void {
  if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
    harness.rejectTerminalTabClose(new Error('terminal_tab_pinned'))
    return
  }
  harness.editSession((session) => ({
    ...session,
    tabsByWorktree: {
      [WORKTREE_ID]: (session.tabsByWorktree[WORKTREE_ID] ?? []).map((tab) => ({
        ...tab,
        isPinned: true
      }))
    }
  }))
}

describe('terminal close and handle incarnation continuity', () => {
  it('delegates a stale spawn-time tab through its current PTY-backed renderer surface', async () => {
    const harness = await createStaleTabCloseHarness()
    const { terminal } = harness

    await expect(harness.runtime.closeTerminalTab(terminal.handle)).resolves.toMatchObject({
      handle: terminal.handle,
      tabId: TAB_ID,
      closeMode: 'tab'
    })

    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      // Main's layout close of the tab that holds the terminal now; the window follows it.
      expect(harness.closeTerminalTab).not.toHaveBeenCalled()
      expect(harness.getSession().tabsByWorktree[WORKTREE_ID]).toEqual([])
    } else {
      expect(harness.closeTerminalTab).toHaveBeenCalledWith(TAB_ID)
    }
  })

  // L259a: switch-on bug waiting on its ledger row's fix.
  ;(ORCA_LAYOUT_OWNER_IS_MAIN ? it.fails : it)(
    'kills and removes a stale spawn-time tab through its current headless surface',
    async () => {
      const harness = await createStaleTabCloseHarness({ headless: true })
      const { terminal } = harness
      const published = vi.fn()
      const unsubscribe = harness.runtime.onMobileSessionTabsChanged(published)

      await expect(harness.runtime.closeTerminalTab(terminal.handle)).resolves.toMatchObject({
        handle: terminal.handle,
        tabId: TAB_ID,
        closeMode: 'tab'
      })

      expect(harness.kill).toHaveBeenCalledWith(RUNTIME_OWNED_PTY_ID)
      expect(harness.getSession().tabsByWorktree[WORKTREE_ID]).toEqual([])
      expect(harness.flushOrThrow.mock.invocationCallOrder[0]).toBeLessThan(
        harness.kill.mock.invocationCallOrder[0]!
      )
      expect(harness.flushOrThrow.mock.invocationCallOrder[0]).toBeLessThan(
        published.mock.invocationCallOrder[0]!
      )
      await expect(
        harness.runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
      ).resolves.toMatchObject({
        retiredTerminalSurfaces: [
          {
            parentTabId: TAB_ID,
            leafId: LEAF_ID,
            ptyId: RUNTIME_OWNED_PTY_ID,
            terminal: terminal.handle,
            incarnationId: INCARNATION_ID
          }
        ],
        tabs: []
      })
      unsubscribe()
    }
  )

  // L259a: switch-on bug waiting on its ledger row's fix.
  ;(ORCA_LAYOUT_OWNER_IS_MAIN ? it.fails : it)(
    'still kills and keeps the removal when the durable headless close fails to flush',
    async () => {
      const harness = await createStaleTabCloseHarness({ headless: true })
      // Switch-on main's layout close stands and is saved again later; switch-off the runtime's does.
      const errorSpy = vi
        .spyOn(console, ORCA_LAYOUT_OWNER_IS_MAIN ? 'warn' : 'error')
        .mockImplementation(() => undefined)
      harness.rejectPersistenceFlush(new Error('disk-full'))

      await expect(
        harness.runtime.closeTerminalTab(harness.terminal.handle)
      ).resolves.toMatchObject({
        tabId: TAB_ID,
        closeMode: 'tab'
      })

      // Why: a failed flush is bookkeeping; the user's close still stops its process and the
      // in-memory removal stays for the next flush to write.
      expect(harness.kill).toHaveBeenCalledWith(RUNTIME_OWNED_PTY_ID)
      expect(harness.getSession().tabsByWorktree[WORKTREE_ID]).toEqual([])
      const snapshot = await harness.runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
      expect(snapshot.tabs).toEqual([])
      expect(errorSpy).toHaveBeenCalledWith(
        ORCA_LAYOUT_OWNER_IS_MAIN
          ? '[layout] a terminal close is applied but not yet saved; saving again later:'
          : '[runtime] failed to persist terminal close:',
        expect.any(Error)
      )
      errorSpy.mockRestore()
    }
  )

  // L255: switch-on bug waiting on its ledger row's fix.
  ;(ORCA_LAYOUT_OWNER_IS_MAIN ? it.fails : it)(
    'publishes each split leaf retirement with its own terminal handle',
    async () => {
      const harness = createHarness({ publishMobileSurface: true, registerPtyBacked: true })
      harness.syncSplitFixtureGraph()
      const before = await harness.runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
      const terminalsByLeafId = new Map(
        before.tabs.flatMap((tab) =>
          tab.type === 'terminal' && tab.terminal ? [[tab.leafId, tab.terminal] as const] : []
        )
      )
      expect(terminalsByLeafId.size).toBe(2)
      harness.syncEmptyGraph()

      await expect(
        harness.runtime.closeMobileSessionTab(`id:${WORKTREE_ID}`, TAB_ID, { reason: 'user' })
      ).resolves.toMatchObject({ closed: true })

      const after = await harness.runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
      expect(after.tabs).toEqual([])
      expect(after.retiredTerminalSurfaces).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            leafId: LEAF_ID,
            ptyId: PTY_ID,
            terminal: terminalsByLeafId.get(LEAF_ID),
            incarnationId: INCARNATION_ID
          }),
          expect.objectContaining({
            leafId: SIBLING_LEAF_ID,
            ptyId: SIBLING_PTY_ID,
            terminal: terminalsByLeafId.get(SIBLING_LEAF_ID),
            incarnationId: SIBLING_INCARNATION_ID
          })
        ])
      )
    }
  )

  // L259b: switch-on bug waiting on its ledger row's fix.
  ;(ORCA_LAYOUT_OWNER_IS_MAIN ? it.fails : it).each(['pane', 'tab'] as const)(
    'closes an exact hot-state %s whose failed reveal left no persisted row',
    async (closeMode) => {
      const harness = await createStaleTabCloseHarness({ headless: true })
      harness.retirePersistedTab()

      await expect(
        closeMode === 'tab'
          ? harness.runtime.closeTerminalTab(harness.terminal.handle)
          : harness.runtime.closeTerminal(harness.terminal.handle)
      ).resolves.toMatchObject({ handle: harness.terminal.handle, tabId: TAB_ID })

      expect(harness.kill).toHaveBeenCalledWith(RUNTIME_OWNED_PTY_ID)
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

  it('does not let a PTY handle cross its recorded worktree boundary', async () => {
    const harness = await createStaleTabCloseHarness({ headless: true })
    const { terminal } = harness
    const register = () =>
      ORCA_LAYOUT_OWNER_IS_MAIN
        ? // The crossing commit binds a new pane in the other workspace first, as every registration
          // does; main's workspace fence (terminalHoldsPane, P2) refuses it the pane (L256).
          registerBoundPty(harness.runtime, RUNTIME_OWNED_PTY_ID, OTHER_WORKTREE_ID, null, {
            tabId: 'tab-close-continuity-crossing',
            leafId: '44444444-4444-4444-8444-444444444444',
            incarnationId: INCARNATION_ID
          })
        : harness.runtime.registerPty(RUNTIME_OWNED_PTY_ID, OTHER_WORKTREE_ID, null, {
            tabId: STALE_TAB_ID,
            leafId: LEAF_ID,
            incarnationId: INCARNATION_ID
          })
    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      expect(register).toThrow('pane_unbound_at_registration')
    } else {
      register()
    }

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
      // Main's layout close answers once its write is durable, and stops the terminal after it.
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
    expect(harness.kill).toHaveBeenCalledWith(PTY_ID)
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
        // Main's layout close: the tab is out of the session, and main's panes, before the stop.
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
      deadlineMs: expect.any(Number)
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

  it('does not kill the final PTY when durable tab retirement is rejected', async () => {
    const harness = createHarness()
    const [{ handle }] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals
    refuseTabClose(harness)

    await expect(harness.runtime.closeTerminal(handle)).rejects.toThrow('terminal_tab_pinned')

    expect(harness.kill).not.toHaveBeenCalled()
    expect(harness.getSession().tabsByWorktree[WORKTREE_ID]).toHaveLength(1)
  })

  // Switch-on main's layout, not the window's graph, says what a close ends; terminal-surface-replies-
  // main.test.ts "close a tab by a pane handle in main, with no session row from the window" covers it.
  it.skipIf(ORCA_LAYOUT_OWNER_IS_MAIN)(
    'requests a stop for every live tab PTY after retirement when the renderer graph is stale',
    async () => {
      const harness = createHarness()
      harness.syncSplitFixtureGraph()
      const terminal = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals.find(
        (candidate) => candidate.ptyId === PTY_ID
      )!
      harness.syncFixtureGraph()

      const closing = harness.runtime.closeTerminal(terminal.handle)
      await vi.waitFor(() => expect(harness.closeTerminalTab).toHaveBeenCalled())
      expect(harness.kill).not.toHaveBeenCalled()

      harness.retirePersistedTab()
      harness.acknowledged.resolve()
      await expect(closing).resolves.toMatchObject({ ptyKilled: false })
      expect(harness.kill).toHaveBeenCalledWith(PTY_ID)
      expect(harness.kill).toHaveBeenCalledWith(SIBLING_PTY_ID)
    }
  )

  it('uses verified teardown after retirement before falling back to kill', async () => {
    const harness = createHarness()
    const [{ handle }] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals
    harness.setVerifiedStopResult(true)

    const closing = closeLastPane(harness, handle)
    await expect(closing).resolves.toMatchObject({ ptyKilled: true })
    expect(harness.stopAndWait).toHaveBeenCalledWith(PTY_ID, {
      deadlineMs: expect.any(Number)
    })
    expect(harness.kill).not.toHaveBeenCalled()
  })

  it('reports an unconfirmed stop on the close receipt rather than a bare uncertain false', async () => {
    const harness = createHarness()
    const [{ handle }] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals
    // Mirrors pty.ts when the SSH provider is gone: the lease is tombstoned, the
    // stop reports false, and the PTY is marked as contact we lost — not a kill.
    harness.kill.mockReturnValue(false)
    harness.setVerifiedStopResult(false)
    harness.runtime.markPtyLivenessUnverifiable(PTY_ID, 'its SSH provider is no longer registered')

    const closing = closeLastPane(harness, handle)

    await expect(closing).resolves.toMatchObject({
      ptyKilled: false,
      ptyStopVerdict: 'unverifiable',
      ptyStopReason: 'its SSH provider is no longer registered'
    })
    expect(harness.kill).not.toHaveBeenCalled()
  })

  it('downgrades a live verdict after issuing an unverified follow-up stop', async () => {
    const harness = createHarness()
    const [{ handle }] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals
    harness.setVerifiedStopResult(false)
    harness.runtime.markPtyLivenessLive(PTY_ID)

    const closing = closeLastPane(harness, handle)

    await expect(closing).resolves.toMatchObject({
      ptyKilled: false,
      ptyStopVerdict: 'unverifiable',
      ptyStopReason: 'a follow-up stop was issued but its outcome could not be verified'
    })
    expect(harness.kill).toHaveBeenCalledWith(PTY_ID)
  })

  it('leaves a confirmed kill receipt free of any stop verdict', async () => {
    const harness = createHarness()
    const [{ handle }] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals
    harness.setVerifiedStopResult(true)

    const closing = closeLastPane(harness, handle)

    const close = await closing
    expect(close.ptyKilled).toBe(true)
    expect(close.ptyStopVerdict).toBeUndefined()
    expect(close.ptyStopReason).toBeUndefined()
  })

  it('reports an unconfirmed stop when verified teardown rejects after retirement', async () => {
    const harness = createHarness()
    const [{ handle }] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals
    harness.setVerifiedStopResult(new Error('provider_unavailable'))

    const closing = closeLastPane(harness, handle)

    await expect(closing).resolves.toMatchObject({
      ptyKilled: false,
      ptyStopVerdict: 'unverifiable',
      ptyStopReason: 'provider_unavailable'
    })
    expect(harness.stopAndWait).toHaveBeenCalledWith(PTY_ID, {
      deadlineMs: expect.any(Number)
    })
    expect(harness.kill).toHaveBeenCalledWith(PTY_ID)
  })

  it('finishes PTY teardown when the session store disappears after retirement', async () => {
    const harness = createPtyBackedPublishedSurfaceHarness()
    const closeMobileSessionTab = vi.spyOn(harness.runtime, 'closeMobileSessionTab')
    const [terminal] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals
    expect(terminal).toMatchObject({ ptyId: RUNTIME_OWNED_PTY_ID })
    const { handle } = terminal

    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      // Main's layout close commits, then the store goes away before the stop finishes.
      harness.setStopAndWaitAction(() => harness.makeSessionUnavailable())
      await expect(harness.runtime.closeTerminal(handle)).resolves.toMatchObject({
        handle,
        tabId: TAB_ID,
        ptyKilled: false
      })
      expect(closeMobileSessionTab).not.toHaveBeenCalled()
      expect(harness.closeTerminalTab).not.toHaveBeenCalled()
    } else {
      const closing = harness.runtime.closeTerminal(handle)
      await vi.waitFor(() => expect(harness.closeTerminalTab).toHaveBeenCalled())
      expect(closeMobileSessionTab).toHaveBeenCalled()
      expect(harness.kill).not.toHaveBeenCalled()

      harness.retirePersistedTab()
      harness.makeSessionUnavailable()
      harness.acknowledged.resolve()

      await expect(closing).resolves.toMatchObject({ handle, tabId: TAB_ID, ptyKilled: false })
      expect(harness.closeTerminal).toHaveBeenCalledWith(TAB_ID)
    }
    expect(harness.stopAndWait).toHaveBeenCalledWith(RUNTIME_OWNED_PTY_ID, {
      deadlineMs: expect.any(Number)
    })
  })

  it('does not tear down a published PTY when retirement fails before acknowledgement', async () => {
    const harness = createPtyBackedPublishedSurfaceHarness()
    refuseTabClose(harness)
    const [terminal] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals

    await expect(harness.runtime.closeTerminal(terminal.handle)).rejects.toThrow(
      'terminal_tab_pinned'
    )
    expect(harness.closeTerminal).not.toHaveBeenCalled()
    expect(harness.stopAndWait).not.toHaveBeenCalled()
    expect(harness.kill).not.toHaveBeenCalled()
  })

  it('keeps a handle valid when renderer reload preserves the PTY incarnation', async () => {
    const harness = createHarness()
    const [before] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals

    harness.runtime.markRendererReloading(1)
    harness.syncFixtureGraph()

    const [after] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals
    expect(after).toMatchObject({ handle: before.handle, incarnationId: INCARNATION_ID })
    await expect(harness.runtime.readTerminal(before.handle)).resolves.toMatchObject({
      handle: before.handle,
      status: 'running'
    })
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

  it('resolves a retained handle waiter when idle arrives during renderer reload', async () => {
    const harness = createHarness()
    const [before] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals
    harness.runtime.onPtyData(PTY_ID, '\x1b]0;\u280b Working on task\x07output\n', 100)
    const waiting = harness.runtime.waitForTerminal(before.handle, {
      condition: 'tui-idle',
      timeoutMs: 1_000
    })

    harness.runtime.markRendererReloading(1)
    harness.runtime.onPtyData(PTY_ID, '\x1b]0;\u2733 Task complete\x07done\n', 200)

    await expect(waiting).resolves.toMatchObject({
      handle: before.handle,
      condition: 'tui-idle',
      satisfied: true
    })
    harness.syncFixtureGraph()
    const [after] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals
    expect(after.handle).toBe(before.handle)
  })

  it('stales the old handle when the same PTY id names a new incarnation', async () => {
    const harness = createHarness()
    const [before] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals

    harness.runtime.markRendererReloading(1)
    // A same-id respawn's commit stamps the pane with the incarnation it now runs.
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

  it('stales a retained handle after the renderer graph becomes unavailable', async () => {
    const harness = createHarness()
    const [before] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals

    harness.runtime.markGraphUnavailable(1)
    harness.runtime.attachWindow(1)
    harness.syncFixtureGraph()

    const [after] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals
    expect(after.handle).not.toBe(before.handle)
    await expect(harness.runtime.readTerminal(before.handle)).rejects.toThrow(
      'terminal_handle_stale'
    )
  })

  it('stales a renderer handle superseded by a preallocated handle', async () => {
    const harness = createHarness()
    const [before] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals
    const preallocated = 'term_preallocated-close-continuity'

    harness.runtime.registerPreAllocatedHandleForPty(PTY_ID, preallocated)
    await expect(harness.runtime.readTerminal(before.handle)).rejects.toThrow(
      'terminal_handle_stale'
    )
    await expect(harness.runtime.readTerminal(preallocated)).resolves.toMatchObject({
      handle: preallocated,
      status: 'running'
    })
    harness.syncFixtureGraph()

    const [after] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals
    expect(after.handle).toBe(preallocated)
    await expect(harness.runtime.readTerminal(preallocated)).resolves.toMatchObject({
      handle: preallocated,
      status: 'running'
    })
  })

  it('keeps a renderer handle when the controller adopts that same handle', async () => {
    const harness = createHarness()
    const [before] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals

    harness.runtime.registerPreAllocatedHandleForPty(PTY_ID, before.handle)
    harness.syncFixtureGraph()

    const [after] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals
    expect(after.handle).toBe(before.handle)
    await expect(harness.runtime.readTerminal(before.handle)).resolves.toMatchObject({
      handle: before.handle,
      status: 'running'
    })
  })

  it('rejects a preallocated-handle waiter when its PTY is invalidated during reload', async () => {
    const harness = createHarness()
    const preallocated = 'term_preallocated-reload-invalidation'
    harness.runtime.registerPreAllocatedHandleForPty(PTY_ID, preallocated)
    harness.syncFixtureGraph()
    harness.runtime.onPtyData(PTY_ID, '\x1b]0;\u280b Working on task\x07output\n', 100)
    const waiting = harness.runtime.waitForTerminal(preallocated, {
      condition: 'tui-idle',
      timeoutMs: 100
    })

    harness.runtime.markRendererReloading(1)
    harness.runtime['invalidateAllHandlesForPty'](PTY_ID)

    await expect(waiting).rejects.toThrow('terminal_handle_stale')
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

async function closeByPty(harness: CloseContinuityHarness): Promise<unknown> {
  const terminal = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals.find(
    (candidate) => candidate.ptyId === PTY_ID
  )
  if (!terminal) {
    throw new Error('fixture pane has no terminal handle')
  }
  return harness.runtime.closeTerminal(terminal.handle)
}

/** A PTY-backed tab with no paired-viewer surface: the path orcad serves to the CLI. */
function headlessPtyTab(): CloseContinuityHarness {
  const harness = createHarness({ registerPtyBacked: true })
  harness.syncFixtureTabWithoutLeaf()
  harness.setVerifiedStopResult(true)
  return harness
}

describe('closing a terminal by PTY on a host without a renderer tab', () => {
  it('stops the PTY without asking a missing renderer to close the tab', async () => {
    const harness = headlessPtyTab()
    harness.syncEmptyGraph()

    await expect(closeByPty(harness)).resolves.toMatchObject({ tabId: TAB_ID })

    expect(harness.closeTerminalTab).not.toHaveBeenCalled()
    expect(harness.stopAndWait).toHaveBeenCalledWith(PTY_ID, expect.anything())
  })

  it('does not fail the close when the advisory renderer notification throws', async () => {
    const harness = headlessPtyTab()
    harness.syncEmptyGraph()
    harness.closeTerminal.mockImplementation(() => {
      throw new Error('renderer gone')
    })

    await expect(closeByPty(harness)).resolves.toMatchObject({ tabId: TAB_ID })
  })
})
