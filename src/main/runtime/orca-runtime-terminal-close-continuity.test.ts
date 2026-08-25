import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { makePaneKey } from '../../shared/stable-pane-id'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { OrcaRuntimeService } from './orca-runtime'

const REPO_ID = 'repo-close-continuity'
const WORKTREE_PATH = '/tmp/terminal-close-continuity'
const WORKTREE_ID = `${REPO_ID}::${WORKTREE_PATH}`
const TAB_ID = 'tab-close-continuity'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const SIBLING_LEAF_ID = '33333333-3333-4333-8333-333333333333'
const CANARY_TAB_ID = 'tab-close-continuity-canary'
const CANARY_LEAF_ID = '55555555-5555-4555-8555-555555555555'
const PTY_ID = 'pty-close-continuity'
const RUNTIME_OWNED_PTY_ID = 'serve-close-continuity'
const SIBLING_PTY_ID = 'pty-close-continuity-sibling'
const CANARY_PTY_ID = 'pty-close-continuity-canary'
const INCARNATION_ID = '22222222-2222-4222-8222-222222222222'
const SIBLING_INCARNATION_ID = '44444444-4444-4444-8444-444444444444'
const CANARY_INCARNATION_ID = '66666666-6666-4666-8666-666666666666'
const canarySessionTab = {
  id: CANARY_TAB_ID,
  ptyId: CANARY_PTY_ID,
  worktreeId: WORKTREE_ID,
  title: 'Canary shell',
  customTitle: null,
  color: null,
  sortOrder: 1,
  createdAt: 2
}
const canarySessionLayout = {
  root: { type: 'leaf' as const, leafId: CANARY_LEAF_ID },
  activeLeafId: CANARY_LEAF_ID,
  expandedLeafId: null,
  ptyIdsByLeafId: { [CANARY_LEAF_ID]: CANARY_PTY_ID }
}
const canarySyncedTab = {
  tabId: CANARY_TAB_ID,
  worktreeId: WORKTREE_ID,
  title: 'Canary shell',
  activeLeafId: CANARY_LEAF_ID,
  layout: { type: 'leaf' as const, leafId: CANARY_LEAF_ID }
}
const canarySyncedLeaf = {
  tabId: CANARY_TAB_ID,
  worktreeId: WORKTREE_ID,
  leafId: CANARY_LEAF_ID,
  paneRuntimeId: 9,
  ptyId: CANARY_PTY_ID
}
const canaryMobileTab = {
  type: 'terminal' as const,
  id: `${CANARY_TAB_ID}::${CANARY_LEAF_ID}`,
  parentTabId: CANARY_TAB_ID,
  leafId: CANARY_LEAF_ID,
  ptyId: CANARY_PTY_ID,
  title: 'Canary shell',
  isActive: false
}
const canaryProcess = {
  id: CANARY_PTY_ID,
  incarnationId: CANARY_INCARNATION_ID,
  cwd: WORKTREE_PATH,
  title: 'Canary shell'
}

function makeSession(ptyId = PTY_ID, includeCanary = false): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [WORKTREE_ID]: [
        {
          id: TAB_ID,
          ptyId,
          worktreeId: WORKTREE_ID,
          title: 'Fixture shell',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        },
        ...(includeCanary ? [canarySessionTab] : [])
      ]
    },
    terminalLayoutsByTabId: {
      [TAB_ID]: {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: ptyId }
      },
      ...(includeCanary ? { [CANARY_TAB_ID]: canarySessionLayout } : {})
    },
    terminalPtyIncarnationsByPaneKey: {
      [makePaneKey(TAB_ID, LEAF_ID)]: INCARNATION_ID,
      ...(includeCanary
        ? { [makePaneKey(CANARY_TAB_ID, CANARY_LEAF_ID)]: CANARY_INCARNATION_ID }
        : {})
    }
  }
}

function makeDeferred() {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function createHarness(
  options: {
    ptyId?: string
    publishMobileSurface?: boolean
    registerPtyBacked?: boolean
    includeCanary?: boolean
  } = {}
) {
  const ptyId = options.ptyId ?? PTY_ID
  let session = makeSession(ptyId, options.includeCanary)
  let sessionAvailable = true
  let incarnationId = INCARNATION_ID
  let includeSiblingPty = false
  let victimPtyListed = true
  const repo = {
    id: REPO_ID,
    path: WORKTREE_PATH,
    displayName: 'close-continuity',
    badgeColor: '#000000',
    addedAt: 1
  }
  const store = {
    getRepos: () => [repo],
    getRepo: (id: string) => (id === REPO_ID ? repo : undefined),
    getAllWorktreeMeta: () => ({}),
    getWorktreeMeta: () => undefined,
    getSettings: () => ({ workspaceDir: '/tmp/workspaces' }),
    getProjects: () => [],
    getWorkspaceSession: () => (sessionAvailable ? session : undefined),
    setWorkspaceSession: (next: WorkspaceSessionState) => {
      session = next
    },
    flushOrThrow: () => {}
  }
  const acknowledged = makeDeferred()
  let closeTerminalTabError: Error | null = null
  let closeTerminalTabAction: (() => void | Promise<void>) | null = null
  const closeTerminal = vi.fn()
  const closeTerminalTab = vi.fn(() => {
    if (closeTerminalTabError) {
      return Promise.reject(closeTerminalTabError)
    }
    return closeTerminalTabAction ? Promise.resolve(closeTerminalTabAction()) : acknowledged.promise
  })
  const kill = vi.fn(() => true)
  let verifiedStopResult: boolean | Error = false
  let stopAndWaitAction: ((stoppingPtyId: string) => void | Promise<void>) | null = null
  const stopAndWait = vi.fn(async (stoppingPtyId: string) => {
    await stopAndWaitAction?.(stoppingPtyId)
    if (verifiedStopResult instanceof Error) {
      throw verifiedStopResult
    }
    return verifiedStopResult
  })
  const listProcesses = vi.fn(async () => [
    ...(victimPtyListed
      ? [
          {
            id: ptyId,
            incarnationId,
            cwd: WORKTREE_PATH,
            title: 'Fixture shell'
          }
        ]
      : []),
    ...(includeSiblingPty
      ? [
          {
            id: SIBLING_PTY_ID,
            incarnationId: SIBLING_INCARNATION_ID,
            cwd: WORKTREE_PATH,
            title: 'Fixture sibling shell'
          }
        ]
      : []),
    ...(options.includeCanary ? [canaryProcess] : [])
  ])
  const runtime = new OrcaRuntimeService(store as never)
  runtime.setNotifier({ closeTerminal, closeTerminalTab } as never)
  runtime.setPtyController({
    write: () => true,
    kill,
    stopAndWait,
    listProcesses,
    getForegroundProcess: async () => null
  })
  runtime.attachWindow(1)

  const syncFixtureGraph = () =>
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: TAB_ID,
          worktreeId: WORKTREE_ID,
          title: 'Fixture shell',
          activeLeafId: LEAF_ID,
          layout: { type: 'leaf', leafId: LEAF_ID }
        },
        ...(options.includeCanary ? [canarySyncedTab] : [])
      ],
      leaves: [
        {
          tabId: TAB_ID,
          worktreeId: WORKTREE_ID,
          leafId: LEAF_ID,
          paneRuntimeId: 7,
          ptyId
        },
        ...(options.includeCanary ? [canarySyncedLeaf] : [])
      ],
      ...(options.publishMobileSurface
        ? {
            mobileSessionTabs: [
              {
                worktree: WORKTREE_ID,
                publicationEpoch: 'renderer:close-continuity',
                snapshotVersion: 1,
                activeGroupId: null,
                activeTabId: `${TAB_ID}::${LEAF_ID}`,
                activeTabType: 'terminal' as const,
                tabs: [
                  {
                    type: 'terminal' as const,
                    id: `${TAB_ID}::${LEAF_ID}`,
                    parentTabId: TAB_ID,
                    leafId: LEAF_ID,
                    ptyId,
                    title: 'Fixture shell',
                    isActive: true
                  },
                  ...(options.includeCanary ? [canaryMobileTab] : [])
                ]
              }
            ]
          }
        : {})
    })
  const syncCanaryGraph = () =>
    runtime.syncWindowGraph(1, {
      tabs: [canarySyncedTab],
      leaves: [canarySyncedLeaf],
      ...(options.publishMobileSurface
        ? {
            mobileSessionTabs: [
              {
                worktree: WORKTREE_ID,
                publicationEpoch: 'renderer:close-continuity',
                snapshotVersion: 2,
                activeGroupId: null,
                activeTabId: `${CANARY_TAB_ID}::${CANARY_LEAF_ID}`,
                activeTabType: 'terminal' as const,
                tabs: [{ ...canaryMobileTab, isActive: true }]
              }
            ]
          }
        : {})
    })
  const syncEmptyGraph = () => runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
  const syncFixtureTabWithoutLeaf = () =>
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: TAB_ID,
          worktreeId: WORKTREE_ID,
          title: 'Fixture shell',
          activeLeafId: LEAF_ID,
          layout: { type: 'leaf', leafId: LEAF_ID }
        },
        ...(options.includeCanary ? [canarySyncedTab] : [])
      ],
      leaves: options.includeCanary ? [canarySyncedLeaf] : []
    })
  const syncSplitFixtureGraph = () => {
    includeSiblingPty = true
    session = {
      ...session,
      terminalLayoutsByTabId: {
        [TAB_ID]: {
          root: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', leafId: LEAF_ID },
            second: { type: 'leaf', leafId: SIBLING_LEAF_ID }
          },
          activeLeafId: LEAF_ID,
          expandedLeafId: null,
          ptyIdsByLeafId: {
            [LEAF_ID]: ptyId,
            [SIBLING_LEAF_ID]: SIBLING_PTY_ID
          }
        }
      },
      terminalPtyIncarnationsByPaneKey: {
        ...session.terminalPtyIncarnationsByPaneKey,
        [makePaneKey(TAB_ID, SIBLING_LEAF_ID)]: SIBLING_INCARNATION_ID
      }
    }
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: TAB_ID,
          worktreeId: WORKTREE_ID,
          title: 'Fixture shell',
          activeLeafId: LEAF_ID,
          layout: session.terminalLayoutsByTabId[TAB_ID]!.root
        }
      ],
      leaves: [
        {
          tabId: TAB_ID,
          worktreeId: WORKTREE_ID,
          leafId: LEAF_ID,
          paneRuntimeId: 7,
          ptyId
        },
        {
          tabId: TAB_ID,
          worktreeId: WORKTREE_ID,
          leafId: SIBLING_LEAF_ID,
          paneRuntimeId: 8,
          ptyId: SIBLING_PTY_ID
        }
      ]
    })
  }

  if (options.registerPtyBacked) {
    runtime.registerPty(ptyId, WORKTREE_ID, null, {
      tabId: TAB_ID,
      leafId: LEAF_ID,
      incarnationId: INCARNATION_ID
    })
    if (options.includeCanary) {
      runtime.registerPty(CANARY_PTY_ID, WORKTREE_ID, null, {
        tabId: CANARY_TAB_ID,
        leafId: CANARY_LEAF_ID,
        incarnationId: CANARY_INCARNATION_ID
      })
    }
  }
  syncFixtureGraph()
  return {
    runtime,
    acknowledged,
    closeTerminal,
    closeTerminalTab,
    kill,
    stopAndWait,
    syncCanaryGraph,
    syncEmptyGraph,
    syncFixtureGraph,
    syncFixtureTabWithoutLeaf,
    syncSplitFixtureGraph,
    getSession: () => session,
    makeSessionUnavailable: () => {
      sessionAvailable = false
    },
    removeVictimFromInventory: () => {
      victimPtyListed = false
    },
    retirePersistedTab: () => {
      const victimPaneKey = makePaneKey(TAB_ID, LEAF_ID)
      session = {
        ...session,
        tabsByWorktree: {
          ...session.tabsByWorktree,
          [WORKTREE_ID]: (session.tabsByWorktree[WORKTREE_ID] ?? []).filter(
            (tab) => tab.id !== TAB_ID
          )
        },
        terminalLayoutsByTabId: Object.fromEntries(
          Object.entries(session.terminalLayoutsByTabId).filter(([tabId]) => tabId !== TAB_ID)
        ),
        terminalPtyIncarnationsByPaneKey: Object.fromEntries(
          Object.entries(session.terminalPtyIncarnationsByPaneKey ?? {}).filter(
            ([paneKey]) => paneKey !== victimPaneKey
          )
        )
      }
    },
    setCloseTerminalTabAction: (action: () => void | Promise<void>) => {
      closeTerminalTabAction = action
    },
    rejectTerminalTabClose: (error: Error) => {
      closeTerminalTabError = error
    },
    setVerifiedStopResult: (result: boolean | Error) => {
      verifiedStopResult = result
    },
    setStopAndWaitAction: (action: (stoppingPtyId: string) => void | Promise<void>) => {
      stopAndWaitAction = action
    },
    replaceIncarnation: (next: string) => {
      incarnationId = next
    }
  }
}

function createPtyBackedPublishedSurfaceHarness() {
  const harness = createHarness({
    ptyId: RUNTIME_OWNED_PTY_ID,
    publishMobileSurface: true,
    registerPtyBacked: true
  })
  harness.syncFixtureTabWithoutLeaf()
  return harness
}

describe('terminal close and handle incarnation continuity', () => {
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
