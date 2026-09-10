import { describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../shared/stable-pane-id'
import {
  CANARY_INCARNATION_ID,
  CANARY_LEAF_ID,
  CANARY_PTY_ID,
  CANARY_TAB_ID,
  createHarness,
  createPtyBackedPublishedSurfaceHarness,
  createStaleTabCloseHarness,
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
  WORKTREE_ID
} from './__fixtures__/orca-runtime-terminal-close-continuity-fixtures'

describe('terminal close and handle incarnation continuity', () => {
  it('delegates a stale spawn-time tab through its current PTY-backed renderer surface', async () => {
    const harness = await createStaleTabCloseHarness()
    const { terminal } = harness

    await expect(harness.runtime.closeTerminalTab(terminal.handle)).resolves.toMatchObject({
      handle: terminal.handle,
      tabId: TAB_ID,
      closeMode: 'tab'
    })

    expect(harness.closeTerminalTab).toHaveBeenCalledWith(TAB_ID)
  })

  it('kills and removes a stale spawn-time tab through its current headless surface', async () => {
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
    await expect(harness.runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)).resolves.toMatchObject(
      {
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
      }
    )
    unsubscribe()
  })

  it('publishes no retirement or absence when the durable headless close fails', async () => {
    const harness = await createStaleTabCloseHarness({ headless: true })
    const published = vi.fn()
    const unsubscribe = harness.runtime.onMobileSessionTabsChanged(published)
    harness.rejectPersistenceFlush(new Error('disk-full'))

    await expect(harness.runtime.closeTerminalTab(harness.terminal.handle)).rejects.toThrow(
      'disk-full'
    )

    expect(harness.kill).not.toHaveBeenCalled()
    expect(published).not.toHaveBeenCalled()
    expect(harness.getSession().tabsByWorktree[WORKTREE_ID]).toHaveLength(1)
    const snapshot = await harness.runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
    expect(snapshot).toMatchObject({
      tabs: [expect.objectContaining({ parentTabId: TAB_ID, leafId: LEAF_ID })]
    })
    expect(snapshot.retiredTerminalSurfaces).toBeUndefined()
    unsubscribe()
  })

  it('publishes each split leaf retirement with its own terminal handle', async () => {
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
  })

  it.each(['pane', 'tab'] as const)(
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
    harness.runtime.registerPty(RUNTIME_OWNED_PTY_ID, OTHER_WORKTREE_ID, null, {
      tabId: STALE_TAB_ID,
      leafId: LEAF_ID,
      incarnationId: INCARNATION_ID
    })

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
    expect(closeMobileSessionTab).toHaveBeenCalledTimes(1)
    expect(closeMobileSessionTab).toHaveBeenCalledWith(`id:${WORKTREE_ID}`, TAB_ID, {
      localPtyTeardownOwnedExternally: true
    })
    expect(harness.closeTerminalTab).toHaveBeenCalledTimes(1)
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
    harness.rejectTerminalTabClose(new Error('terminal_tab_pinned'))

    await expect(harness.runtime.closeTerminal(handle)).rejects.toThrow('terminal_tab_pinned')

    expect(harness.kill).not.toHaveBeenCalled()
    expect(harness.getSession().tabsByWorktree[WORKTREE_ID]).toHaveLength(1)
  })

  it('requests a stop for every live tab PTY after retirement when the renderer graph is stale', async () => {
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
  })

  it('uses verified teardown after retirement before falling back to kill', async () => {
    const harness = createHarness()
    const [{ handle }] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals
    harness.setVerifiedStopResult(true)

    const closing = harness.runtime.closeTerminal(handle)
    await vi.waitFor(() => expect(harness.closeTerminalTab).toHaveBeenCalled())
    expect(harness.stopAndWait).not.toHaveBeenCalled()

    harness.retirePersistedTab()
    harness.acknowledged.resolve()
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

    const closing = harness.runtime.closeTerminal(handle)
    await vi.waitFor(() => expect(harness.closeTerminalTab).toHaveBeenCalled())
    harness.retirePersistedTab()
    harness.acknowledged.resolve()

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

    const closing = harness.runtime.closeTerminal(handle)
    await vi.waitFor(() => expect(harness.closeTerminalTab).toHaveBeenCalled())
    harness.retirePersistedTab()
    harness.acknowledged.resolve()

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

    const closing = harness.runtime.closeTerminal(handle)
    await vi.waitFor(() => expect(harness.closeTerminalTab).toHaveBeenCalled())
    harness.retirePersistedTab()
    harness.acknowledged.resolve()

    const close = await closing
    expect(close.ptyKilled).toBe(true)
    expect(close.ptyStopVerdict).toBeUndefined()
    expect(close.ptyStopReason).toBeUndefined()
  })

  it('reports an unconfirmed stop when verified teardown rejects after retirement', async () => {
    const harness = createHarness()
    const [{ handle }] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals
    harness.setVerifiedStopResult(new Error('provider_unavailable'))

    const closing = harness.runtime.closeTerminal(handle)
    await vi.waitFor(() => expect(harness.closeTerminalTab).toHaveBeenCalled())
    harness.retirePersistedTab()
    harness.acknowledged.resolve()

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

    const closing = harness.runtime.closeTerminal(handle)
    await vi.waitFor(() => expect(harness.closeTerminalTab).toHaveBeenCalled())
    expect(closeMobileSessionTab).toHaveBeenCalled()
    expect(harness.kill).not.toHaveBeenCalled()

    harness.retirePersistedTab()
    harness.makeSessionUnavailable()
    harness.acknowledged.resolve()

    await expect(closing).resolves.toMatchObject({ handle, tabId: TAB_ID, ptyKilled: false })
    expect(harness.closeTerminal).toHaveBeenCalledWith(TAB_ID)
    expect(harness.stopAndWait).toHaveBeenCalledWith(RUNTIME_OWNED_PTY_ID, {
      deadlineMs: expect.any(Number)
    })
  })

  it('does not tear down a published PTY when retirement fails before acknowledgement', async () => {
    const harness = createPtyBackedPublishedSurfaceHarness()
    harness.rejectTerminalTabClose(new Error('terminal_tab_pinned'))
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
    harness.replaceIncarnation('33333333-3333-4333-8333-333333333333')
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
