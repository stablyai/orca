import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import type { TerminalLayoutSnapshot } from '../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { makePaneKey } from '../../shared/stable-pane-id'
import { OrcaRuntimeService } from './orca-runtime'

const REPO_ID = 'repo-1'
const WORKTREE_ID = `${REPO_ID}::/workspace`
const TAB_ID = 'tab-remote'
const SOURCE_LEAF_ID = '11111111-1111-4111-8111-111111111111'
const SOURCE_PTY_ID = 'pty-source'
const SPLIT_PTY_ID = 'pty-split'

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
    graphOnlySource?: boolean
    sourceIncarnationId?: string
    stopAndWaitResult?: boolean
  } = {}
) {
  let session = persistedSession(includeSource)
  const connectionId = options.connectionId ?? null
  const ownerHostId = connectionId ? `ssh:${connectionId}` : 'local'
  const requestedSessionHostIds: (string | undefined)[] = []
  const repo = {
    id: REPO_ID,
    path: '/workspace',
    displayName: 'repo',
    badgeColor: 'blue',
    addedAt: 1,
    ...(connectionId ? { connectionId } : {})
  }
  const store = {
    getRepos: () => [repo],
    getRepo: (id: string) => (id === REPO_ID ? repo : undefined),
    getWorkspaceSession: (hostId?: string) => {
      requestedSessionHostIds.push(hostId)
      return hostId === undefined || hostId === ownerHostId ? session : getDefaultWorkspaceSession()
    },
    setWorkspaceSession: (next: WorkspaceSessionState) => {
      session = next
    },
    persistPtyBinding: () => true
  }
  let resolveSpawn: ((result: { id: string }) => void) | undefined
  const spawn = options.deferSpawn
    ? vi.fn(
        () =>
          new Promise<{ id: string }>((resolve) => {
            resolveSpawn = resolve
          })
      )
    : vi.fn(async () => ({ id: SPLIT_PTY_ID }))
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
              ptyId: SOURCE_PTY_ID
            }
          ]
        : [],
    mobileSessionTabs: (options.includePairedSnapshot ?? includeSource) ? [remoteSnapshot()] : []
  })
  if (!options.graphOnlySource) {
    runtime.registerPty(SOURCE_PTY_ID, WORKTREE_ID, connectionId, {
      tabId: TAB_ID,
      leafId: SOURCE_LEAF_ID,
      ...(options.sourceIncarnationId ? { incarnationId: options.sourceIncarnationId } : {})
    })
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
    replaceSourceIncarnation: (incarnationId: string) =>
      runtime.registerPty(SOURCE_PTY_ID, WORKTREE_ID, connectionId, {
        tabId: TAB_ID,
        leafId: SOURCE_LEAF_ID,
        incarnationId
      }),
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
    resolveSpawn: () => resolveSpawn?.({ id: SPLIT_PTY_ID })
  }
}

describe('remote runtime terminal split authority', () => {
  it('addresses a graph-backed split by stable leaf identity across a parked remount', async () => {
    const harness = createHarness(true, { rendererMounted: true, graphOnlySource: true })

    const split = harness.runtime.splitTerminal(harness.handle, { direction: 'vertical' })

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

  it('splits a persisted tab without consulting an unmounted host renderer', async () => {
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
    expect.soft(harness.revealTerminalSession).not.toHaveBeenCalled()
    const persistedLayout = harness.getSession().terminalLayoutsByTabId[TAB_ID]
    expect(persistedLayout).toMatchObject({
      root: { type: 'split', direction: 'vertical' },
      ptyIdsByLeafId: {
        [SOURCE_LEAF_ID]: SOURCE_PTY_ID
      }
    })
    expect(Object.values(persistedLayout!.ptyIdsByLeafId!)).toContain(SPLIT_PTY_ID)
    const siblingSurfaces = harness
      .getSnapshot()!
      .tabs.filter(
        (tab): tab is Extract<typeof tab, { type: 'terminal' }> =>
          tab.type === 'terminal' && tab.parentTabId === TAB_ID
      )
    expect(siblingSurfaces).toHaveLength(2)
    expect(siblingSurfaces.every((tab) => tab.parentLayout?.root?.type === 'split')).toBe(true)
  })

  it('rejects an unowned split source before spawning a PTY', async () => {
    const harness = createHarness(false)

    const outcome = await harness.runtime
      .splitTerminal(harness.handle, { direction: 'vertical' })
      .then(() => 'resolved')
      .catch((error: unknown) => (error instanceof Error ? error.message : String(error)))

    expect.soft(outcome).toBe('terminal_split_source_not_found')
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
      stopAndWaitResult: true
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
    expect(harness.retireRejectedPty).toHaveBeenCalledWith(SPLIT_PTY_ID, true)
  })

  it('revalidates a projected paired-runtime source after renderer adoption', async () => {
    const harness = createHarness(false, {
      deferReveal: true,
      includePairedSnapshot: true,
      sourceIncarnationId: 'projected-before',
      stopAndWaitResult: false
    })

    const split = harness.runtime.splitTerminal(harness.handle, { direction: 'horizontal' })
    await vi.waitFor(() => expect(harness.revealTerminalSession).toHaveBeenCalledOnce())
    expect(harness.spawn).toHaveBeenCalledWith(
      expect.not.objectContaining({ expectedSourceBinding: expect.anything() })
    )

    harness.replaceSourceIncarnation('projected-after')
    harness.resolveReveal()

    await expect(split).rejects.toThrow('terminal_split_source_not_found')
    expect(harness.stopAndWait).toHaveBeenCalledWith(
      SPLIT_PTY_ID,
      expect.objectContaining({ deadlineMs: expect.any(Number) })
    )
    expect(harness.kill).toHaveBeenCalledWith(SPLIT_PTY_ID)
    expect(harness.retireRejectedPty).toHaveBeenCalledWith(SPLIT_PTY_ID, false)
  })

  it('preserves the split error when kill and retirement throw', async () => {
    const harness = createHarness(false, {
      deferReveal: true,
      includePairedSnapshot: true,
      sourceIncarnationId: 'projected-before',
      stopAndWaitResult: false
    })
    harness.kill.mockImplementation(() => {
      throw new Error('kill failed')
    })
    harness.retireRejectedPty.mockImplementation(() => {
      throw new Error('retire failed')
    })

    const split = harness.runtime.splitTerminal(harness.handle, { direction: 'horizontal' })
    await vi.waitFor(() => expect(harness.revealTerminalSession).toHaveBeenCalledOnce())
    harness.replaceSourceIncarnation('projected-after')
    harness.resolveReveal()

    await expect(split).rejects.toThrow('terminal_split_source_not_found')
    expect(harness.kill).toHaveBeenCalledWith(SPLIT_PTY_ID)
    expect(harness.retireRejectedPty).toHaveBeenCalledWith(SPLIT_PTY_ID, false)
  })
})
