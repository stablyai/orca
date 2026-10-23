import { withRuntimePaneAdmission } from './runtime-durable-store-fixture'
import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import type { TerminalLayoutSnapshot } from '../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { makePaneKey } from '../../shared/stable-pane-id'
import { collectLeafIds } from '../../shared/terminal-pane-layout-tree'
import { OrcaRuntimeService } from './orca-runtime'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'
import { bindPaneFirst, committingSpawn } from './bind-first-pane.test-fixture'

const REPO_ID = 'repo-1'
const WORKTREE_ID = `${REPO_ID}::/workspace`
const TAB_ID = 'tab-remote'
const SOURCE_LEAF_ID = '11111111-1111-4111-8111-111111111111'
const SOURCE_PTY_ID = 'pty-source'
const SPLIT_PTY_ID = 'pty-split'
const SPLIT_INCARNATION_ID = 'pty-split-inc'
// Switch-on, main stamps the source's pane with its terminal's incarnation, so they start equal.
const SOURCE_STAMPED_BEFORE = ORCA_LAYOUT_OWNER_IS_MAIN
  ? { sourceIncarnationId: 'persisted-before' }
  : {}
// Switch-on, a source main's layout no longer holds has no pane, so its handle is stale first.
const UNOWNED_SOURCE_ERROR = ORCA_LAYOUT_OWNER_IS_MAIN
  ? 'terminal_handle_stale'
  : 'terminal_split_source_not_found'

function sourceLayout(): TerminalLayoutSnapshot {
  return {
    root: { type: 'leaf', leafId: SOURCE_LEAF_ID },
    activeLeafId: SOURCE_LEAF_ID,
    expandedLeafId: null,
    ptyIdsByLeafId: { [SOURCE_LEAF_ID]: SOURCE_PTY_ID }
  }
}

function persistedSession(includeSource = true): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: includeSource
      ? {
          [WORKTREE_ID]: [
            {
              id: TAB_ID,
              ptyId: SOURCE_PTY_ID,
              worktreeId: WORKTREE_ID,
              title: 'Remote terminal',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        }
      : {},
    terminalLayoutsByTabId: includeSource ? { [TAB_ID]: sourceLayout() } : {}
  }
}

function remoteSnapshot(): RuntimeMobileSessionTabsSnapshot {
  const layout = sourceLayout()
  return {
    worktree: WORKTREE_ID,
    publicationEpoch: 'remote-viewer',
    snapshotVersion: 1,
    activeGroupId: 'group-1',
    activeTabId: `${TAB_ID}::${SOURCE_LEAF_ID}`,
    activeTabType: 'terminal',
    tabGroups: [{ id: 'group-1', activeTabId: TAB_ID, tabOrder: [TAB_ID] }],
    tabs: [
      {
        type: 'terminal',
        id: `${TAB_ID}::${SOURCE_LEAF_ID}`,
        parentTabId: TAB_ID,
        leafId: SOURCE_LEAF_ID,
        ptyId: SOURCE_PTY_ID,
        title: 'Remote terminal',
        parentLayout: layout,
        isActive: true
      }
    ]
  }
}

function createHarness(
  includeSource = true,
  options: {
    connectionId?: string | null
    deferReveal?: boolean
    deferSpawn?: boolean
    includePairedSnapshot?: boolean
    rendererMounted?: boolean
    rendererPtyId?: string | null
    graphOnlySource?: boolean
    sourceIncarnationId?: string
    stopAndWaitResult?: boolean
  } = {}
) {
  let session = persistedSession(includeSource)
  const connectionId = options.connectionId ?? null
  const ownerHostId = connectionId ? `ssh:${connectionId}` : 'local'
  const requestedSessionHostIds: (string | undefined)[] = []
  // The fixture's own spawn-commit reads are not the split's.
  let committingPane = false
  const repo = {
    id: REPO_ID,
    path: '/workspace',
    displayName: 'repo',
    badgeColor: 'blue',
    addedAt: 1,
    ...(connectionId ? { connectionId } : {})
  }
  const store = withRuntimePaneAdmission({
    getRepos: () => [repo],
    getRepo: (id: string) => (id === REPO_ID ? repo : undefined),
    getWorkspaceSession: (hostId?: string) => {
      if (!committingPane) {
        requestedSessionHostIds.push(hostId)
      }
      return hostId === undefined || hostId === ownerHostId ? session : getDefaultWorkspaceSession()
    },
    setWorkspaceSession: (next: WorkspaceSessionState) => {
      session = next
    },
    persistPtyBinding: () => true
  })
  let resolveSpawn: ((result: { id: string; incarnationId: string }) => void) | undefined
  const kill = vi.fn(() => true)
  const retireRejectedPty = vi.fn()
  const stopAndWait = vi.fn(async () => options.stopAndWaitResult ?? true)
  let resolveReveal: ((result: { tabId: string }) => void) | undefined
  const revealTerminalSession = options.deferReveal
    ? vi.fn(
        () =>
          new Promise<{ tabId: string }>((resolve) => {
            resolveReveal = resolve
          })
      )
    : vi.fn().mockRejectedValue(new Error(`Terminal tab ${TAB_ID} not found`))
  const rendererSplitTerminal = vi.fn()
  const runtime = new OrcaRuntimeService(store as never)
  // As the PTY host's spawn commit: the split's pane is bound once its terminal starts.
  const spawn = options.deferSpawn
    ? vi.fn(
        committingSpawn(
          runtime,
          (_args: { worktreeId?: string; tabId?: string; leafId?: string }) =>
            new Promise<{ id: string; incarnationId?: string }>((resolve) => {
              resolveSpawn = resolve
            })
        )
      )
    : vi.fn(
        committingSpawn(
          runtime,
          async (_args: { worktreeId?: string; tabId?: string; leafId?: string }) => ({
            id: SPLIT_PTY_ID
          })
        )
      )
  Object.assign(runtime, {
    resolveTerminalWorkspaceLaunchScope: vi.fn(async () => ({
      id: WORKTREE_ID,
      path: '/workspace',
      connectionId,
      repo,
      folderWorkspace: null
    }))
  })
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill,
    retireRejectedPty,
    ...(options.stopAndWaitResult !== undefined ? { stopAndWait } : {}),
    getForegroundProcess: async () => null
  })
  runtime.setNotifier({ revealTerminalSession, splitTerminal: rendererSplitTerminal } as never)
  runtime.syncWindowGraph(1, {
    tabs:
      includeSource && options.rendererMounted
        ? [
            {
              tabId: TAB_ID,
              worktreeId: WORKTREE_ID,
              title: 'Restored terminal',
              activeLeafId: SOURCE_LEAF_ID,
              layout: { type: 'leaf', leafId: SOURCE_LEAF_ID } as const
            }
          ]
        : [],
    leaves:
      includeSource && options.rendererMounted
        ? [
            {
              tabId: TAB_ID,
              worktreeId: WORKTREE_ID,
              leafId: SOURCE_LEAF_ID,
              paneRuntimeId: 1,
              ptyId: options.rendererPtyId === undefined ? SOURCE_PTY_ID : options.rendererPtyId
            }
          ]
        : [],
    mobileSessionTabs: (options.includePairedSnapshot ?? includeSource) ? [remoteSnapshot()] : []
  })
  // As the PTY host's spawn commit: the source's pane is bound in its owner's partition first.
  const registerSource = (incarnationId?: string) => {
    committingPane = true
    try {
      bindPaneFirst(
        runtime,
        { worktreeId: WORKTREE_ID, tabId: TAB_ID, leafId: SOURCE_LEAF_ID, ptyId: SOURCE_PTY_ID },
        ownerHostId
      )
    } finally {
      committingPane = false
    }
    runtime.registerPty(SOURCE_PTY_ID, WORKTREE_ID, connectionId, {
      tabId: TAB_ID,
      leafId: SOURCE_LEAF_ID,
      ...(incarnationId ? { incarnationId } : {})
    })
  }
  if (!options.graphOnlySource) {
    registerSource(options.sourceIncarnationId)
    if (!includeSource && ORCA_LAYOUT_OWNER_IS_MAIN) {
      // Switch-on, a registered terminal's pane was bound first, so an unowned source is one
      // whose tab was closed since: the saved session no longer lists it.
      session = persistedSession(false)
    }
  }
  const internals = runtime as unknown as {
    issueHandle: (leaf: unknown) => string
    issuePtyHandle: (pty: unknown) => string
    leaves: Map<string, unknown>
    mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
    ptysById: Map<string, unknown>
  }
  const handle = options.graphOnlySource
    ? internals.issueHandle([...internals.leaves.values()][0])
    : internals.issuePtyHandle(internals.ptysById.get(SOURCE_PTY_ID))
  return {
    runtime,
    handle,
    spawn,
    kill,
    retireRejectedPty,
    stopAndWait,
    revealTerminalSession,
    rendererSplitTerminal,
    getSession: () => session,
    getSnapshot: () => internals.mobileSessionTabsByWorktree.get(WORKTREE_ID),
    requestedSessionHostIds,
    replaceSourceIncarnation: (incarnationId: string) => registerSource(incarnationId),
    replacePersistedSourceIncarnation: (incarnationId: string) => {
      session = {
        ...session,
        terminalPtyIncarnationsByPaneKey: {
          ...session.terminalPtyIncarnationsByPaneKey,
          [makePaneKey(TAB_ID, SOURCE_LEAF_ID)]: incarnationId
        }
      }
    },
    resolveReveal: () => resolveReveal?.({ tabId: TAB_ID }),
    resolveSpawn: () => resolveSpawn?.({ id: SPLIT_PTY_ID, incarnationId: SPLIT_INCARNATION_ID })
  }
}

describe('remote runtime terminal split authority', () => {
  it('addresses a graph-backed split by stable leaf identity across a parked remount', async () => {
    const harness = createHarness(true, { rendererMounted: true, graphOnlySource: true })
    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      // Main writes the split and starts its terminal under the new pane's stable id; no window
      // is asked, so a parked or remounting tab cannot hold the split up.
      const started = await harness.runtime.splitTerminal(harness.handle, {
        direction: 'vertical'
      })
      const startedLeafId = started.leafId ?? ''
      expect(harness.rendererSplitTerminal).not.toHaveBeenCalled()
      expect(started).toMatchObject({ tabId: TAB_ID, handle: expect.stringMatching(/^term_/) })
      expect(harness.spawn).toHaveBeenCalledWith(
        expect.objectContaining({ tabId: TAB_ID, leafId: startedLeafId })
      )
      expect(collectLeafIds(harness.getSession().terminalLayoutsByTabId[TAB_ID]?.root)).toEqual([
        SOURCE_LEAF_ID,
        startedLeafId
      ])
      return
    }

    const split = harness.runtime.splitTerminal(harness.handle, { direction: 'vertical' })
    await vi.waitFor(() => expect(harness.rendererSplitTerminal).toHaveBeenCalled())

    const newLeafId = harness.rendererSplitTerminal.mock.calls[0]?.[2]?.newLeafId
    expect(newLeafId).toEqual(expect.any(String))
    if (typeof newLeafId !== 'string') {
      throw new Error('split notifier did not receive a pre-minted leaf id')
    }
    expect(harness.rendererSplitTerminal).toHaveBeenCalledWith(TAB_ID, 1, {
      direction: 'vertical',
      command: undefined,
      worktreeId: WORKTREE_ID,
      sourceLeafId: SOURCE_LEAF_ID,
      telemetrySource: undefined,
      newLeafId
    })
    harness.runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: TAB_ID,
          worktreeId: WORKTREE_ID,
          title: 'Restored terminal',
          activeLeafId: SOURCE_LEAF_ID,
          layout: {
            type: 'split',
            direction: 'vertical',
            ratio: 0.5,
            first: { type: 'leaf', leafId: SOURCE_LEAF_ID },
            second: { type: 'leaf', leafId: newLeafId }
          }
        }
      ],
      leaves: [
        {
          tabId: TAB_ID,
          worktreeId: WORKTREE_ID,
          leafId: SOURCE_LEAF_ID,
          paneRuntimeId: 7,
          ptyId: SOURCE_PTY_ID
        },
        {
          tabId: TAB_ID,
          worktreeId: WORKTREE_ID,
          leafId: newLeafId,
          paneRuntimeId: 8,
          ptyId: SPLIT_PTY_ID
        }
      ]
    })

    await expect(split).resolves.toMatchObject({
      tabId: TAB_ID,
      handle: expect.stringMatching(/^term_/)
    })
  })

  it('reveals a persisted split while its mounted source is still publishing its PTY binding', async () => {
    const harness = createHarness(true, { rendererMounted: true, rendererPtyId: null })
    await harness.runtime.splitTerminal(harness.handle, { direction: 'vertical' })
    expect(harness.revealTerminalSession).toHaveBeenCalledOnce()
    expect(harness.getSession().terminalLayoutsByTabId[TAB_ID]?.root?.type).toBe('split')
  })

  // Switch-off only: with the switch on, main's leaves stand in for the window's in workspaces main
  // owns, so a window pane bound to another terminal cannot exist (terminal-split-source-authority.ts).
  it.skipIf(ORCA_LAYOUT_OWNER_IS_MAIN)(
    'does not reveal a persisted split into a renderer bound to a different PTY',
    async () => {
      const harness = createHarness(true, { rendererMounted: true, rendererPtyId: 'replacement' })
      await harness.runtime.splitTerminal(harness.handle, { direction: 'vertical' })
      expect(harness.revealTerminalSession).not.toHaveBeenCalled()
    }
  )

  // STA-9417: the window's graph lags a tab it already holds, so the split is offered regardless;
  // a window without the tab rejects it and the persisted split stands.
  it('splits a persisted tab the window has not listed, and still offers it to the window', async () => {
    const harness = createHarness()

    const outcome = await harness.runtime
      .splitTerminal(harness.handle, { direction: 'vertical' })
      .then((split) => ({ ok: true as const, split }))
      .catch((error: unknown) => ({ ok: false as const, error }))

    expect.soft(outcome).toMatchObject({
      ok: true,
      split: { tabId: TAB_ID, handle: expect.stringMatching(/^term_/) }
    })
    expect.soft(harness.spawn).toHaveBeenCalledTimes(1)
    expect.soft(harness.kill).not.toHaveBeenCalled()
    expect.soft(harness.revealTerminalSession).toHaveBeenCalledWith(
      WORKTREE_ID,
      expect.objectContaining({
        ptyId: SPLIT_PTY_ID,
        tabId: TAB_ID,
        splitFromLeafId: SOURCE_LEAF_ID
      })
    )
    const persistedLayout = harness.getSession().terminalLayoutsByTabId[TAB_ID]
    expect(persistedLayout).toMatchObject({
      root: { type: 'split', direction: 'vertical' },
      ptyIdsByLeafId: {
        [SOURCE_LEAF_ID]: SOURCE_PTY_ID
      }
    })
    const siblingSurfaces = harness
      .getSnapshot()!
      .tabs.filter(
        (tab): tab is Extract<typeof tab, { type: 'terminal' }> =>
          tab.type === 'terminal' && tab.parentTabId === TAB_ID
      )
    expect(siblingSurfaces).toHaveLength(2)
    expect(siblingSurfaces.every((tab) => tab.parentLayout?.root?.type === 'split')).toBe(true)
  })

  it("gives a split the host's account env, under the caller's own env", async () => {
    const harness = createHarness()
    harness.runtime.setHostAccountLaunchEnv({
      wslDistro: 'Ubuntu',
      claude: {},
      terminal: { CODEX_HOME: '/home/u/.orca/codex/b', ORCA_CLAUDE_PROFILE_POINTER: '~/p' }
    })

    await harness.runtime.splitTerminal(harness.handle, {
      direction: 'vertical',
      env: { ORCA_CLAUDE_PROFILE_POINTER: '~/caller' }
    })

    expect(harness.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          CODEX_HOME: '/home/u/.orca/codex/b',
          ORCA_CLAUDE_PROFILE_POINTER: '~/caller'
        })
      })
    )
  })

  it('rejects an unowned split source before spawning a PTY', async () => {
    const harness = createHarness(false)

    const outcome = await harness.runtime
      .splitTerminal(harness.handle, { direction: 'vertical' })
      .then(() => 'resolved')
      .catch((error: unknown) => (error instanceof Error ? error.message : String(error)))

    expect.soft(outcome).toBe(UNOWNED_SOURCE_ERROR)
    expect.soft(harness.spawn).not.toHaveBeenCalled()
    expect.soft(harness.kill).not.toHaveBeenCalled()
    expect.soft(harness.revealTerminalSession).not.toHaveBeenCalled()
  })

  it.each([
    { label: 'local', connectionId: null, expectedHostId: 'local' },
    { label: 'SSH', connectionId: 'ssh-1', expectedHostId: 'ssh:ssh-1' }
  ])(
    'rejects a same-ID $label source replacement when restored persistence lacks an incarnation',
    async ({ connectionId, expectedHostId }) => {
      const harness = createHarness(true, {
        connectionId,
        deferSpawn: true,
        includePairedSnapshot: false,
        rendererMounted: true,
        sourceIncarnationId: 'source-before'
      })

      const split = harness.runtime.splitTerminal(harness.handle, { direction: 'vertical' })
      await vi.waitFor(() => expect(harness.spawn).toHaveBeenCalledOnce())

      expect(
        harness.getSession().terminalPtyIncarnationsByPaneKey?.[makePaneKey(TAB_ID, SOURCE_LEAF_ID)]
      ).toBeUndefined()
      expect(harness.spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          expectedSourceBinding: expect.objectContaining({ ptyId: SOURCE_PTY_ID })
        })
      )
      // Why: persistence never recorded this incarnation, so sending it would make the store
      // reject every split from a restored pane; the live id is fenced in-runtime instead.
      expect(harness.spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          expectedSourceBinding: expect.not.objectContaining({ incarnationId: expect.anything() })
        })
      )

      harness.replaceSourceIncarnation('source-after')
      harness.resolveSpawn()

      await expect(split).rejects.toThrow('terminal_split_source_not_found')
      expect(harness.kill).toHaveBeenCalledWith(SPLIT_PTY_ID)
      expect(harness.requestedSessionHostIds).toContain(expectedHostId)
    }
  )

  it('rejects a same-ID paired-runtime source replacement recovered without an incarnation map', async () => {
    const harness = createHarness(true, {
      deferSpawn: true,
      includePairedSnapshot: true,
      rendererMounted: false,
      sourceIncarnationId: 'remote-before'
    })

    const split = harness.runtime.splitTerminal(harness.handle, { direction: 'horizontal' })
    await vi.waitFor(() => expect(harness.spawn).toHaveBeenCalledOnce())
    expect(harness.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedSourceBinding: expect.not.objectContaining({ incarnationId: expect.anything() })
      })
    )

    harness.replaceSourceIncarnation('remote-after')
    harness.resolveSpawn()

    await expect(split).rejects.toThrow('terminal_split_source_not_found')
    expect(harness.kill).toHaveBeenCalledWith(SPLIT_PTY_ID)
    expect(harness.revealTerminalSession).not.toHaveBeenCalled()
  })

  it('rejects a persisted-only source incarnation change during spawn', async () => {
    const harness = createHarness(true, {
      deferSpawn: true,
      includePairedSnapshot: false,
      stopAndWaitResult: true,
      ...SOURCE_STAMPED_BEFORE
    })
    harness.replacePersistedSourceIncarnation('persisted-before')

    const split = harness.runtime.splitTerminal(harness.handle, { direction: 'horizontal' })
    await vi.waitFor(() => expect(harness.spawn).toHaveBeenCalledOnce())
    harness.replacePersistedSourceIncarnation('persisted-after')
    harness.resolveSpawn()

    await expect(split).rejects.toThrow('terminal_split_source_not_found')
    expect(harness.stopAndWait).toHaveBeenCalledWith(
      SPLIT_PTY_ID,
      expect.objectContaining({ deadlineMs: expect.any(Number) })
    )
    expect(harness.kill).not.toHaveBeenCalled()
    expect(harness.retireRejectedPty).toHaveBeenCalledWith(SPLIT_PTY_ID, true, SPLIT_INCARNATION_ID)
  })

  it('refuses a split whose source is only projected, before spawning', async () => {
    const harness = createHarness(false, { includePairedSnapshot: true })

    await expect(
      harness.runtime.splitTerminal(harness.handle, { direction: 'horizontal' })
    ).rejects.toThrow(UNOWNED_SOURCE_ERROR)
    expect(harness.spawn).not.toHaveBeenCalled()
    expect(harness.revealTerminalSession).not.toHaveBeenCalled()
  })

  it('preserves the split error and takes back the pane when kill and retirement throw', async () => {
    const harness = createHarness(true, {
      deferSpawn: true,
      includePairedSnapshot: false,
      stopAndWaitResult: false,
      ...SOURCE_STAMPED_BEFORE
    })
    harness.kill.mockImplementation(() => {
      throw new Error('kill failed')
    })
    harness.retireRejectedPty.mockImplementation(() => {
      throw new Error('retire failed')
    })
    harness.replacePersistedSourceIncarnation('persisted-before')

    const split = harness.runtime.splitTerminal(harness.handle, { direction: 'horizontal' })
    await vi.waitFor(() => expect(harness.spawn).toHaveBeenCalledOnce())
    harness.replacePersistedSourceIncarnation('persisted-after')
    harness.resolveSpawn()

    await expect(split).rejects.toThrow('terminal_split_source_not_found')
    expect(harness.kill).toHaveBeenCalledWith(SPLIT_PTY_ID)
    expect(harness.retireRejectedPty).toHaveBeenCalledWith(
      SPLIT_PTY_ID,
      false,
      SPLIT_INCARNATION_ID
    )
    expect(harness.getSession().terminalLayoutsByTabId[TAB_ID]?.root).toEqual({
      type: 'leaf',
      leafId: SOURCE_LEAF_ID
    })
  })
})
