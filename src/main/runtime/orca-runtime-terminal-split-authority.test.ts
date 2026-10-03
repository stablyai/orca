import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import type { TerminalLayoutSnapshot } from '../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { makePaneKey } from '../../shared/stable-pane-id'
import { OrcaRuntimeService } from './orca-runtime'
import { setRuntimeDesktopSurface } from './runtime-desktop-surface'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import type { TerminalHandleRecord } from './runtime-terminal-contracts'
import { TERMINAL_SPLIT_RATIO_LOCAL_DESKTOP_RUNTIME_CAPABILITY } from '../../shared/protocol-version'

afterEach(() => setRuntimeDesktopSurface(null))

function provideDesktop() {
  const window = { isDestroyed: () => false, webContents: { isDestroyed: () => false } }
  setRuntimeDesktopSurface({
    showNotification: () => false,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: split eligibility reads only window liveness and identity.
    findWindowById: () => window as never,
    onIpc: () => {},
    removeIpcListener: () => {}
  })
  return window
}

const REPO_ID = 'repo-1'
const WORKTREE_ID = `${REPO_ID}::/workspace`
const TAB_ID = 'tab-remote'
const SOURCE_LEAF_ID = '11111111-1111-4111-8111-111111111111'
const SPLIT_LEAF_ID = '22222222-2222-4222-8222-222222222222'
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

function persistedSession(includeSource = true, worktreeId = WORKTREE_ID): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: includeSource
      ? {
          [worktreeId]: [
            {
              id: TAB_ID,
              ptyId: SOURCE_PTY_ID,
              worktreeId,
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

function remoteSnapshot(worktreeId = WORKTREE_ID): RuntimeMobileSessionTabsSnapshot {
  const layout = sourceLayout()
  return {
    worktree: worktreeId,
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
    worktreeId?: string
    repoHosts?: string[]
    repoKind?: 'git' | 'folder'
    worktreeHostId?: string
    folder?: {
      executionHostId?: string
      connectionId?: string
      folderPath?: string
      projectGroupId?: string
    }
    group?: { executionHostId?: string; connectionId?: string; parentPath?: string }
    connectionId?: string | null
    deferReveal?: boolean
    deferSpawn?: boolean
    includePairedSnapshot?: boolean
    rendererMounted?: boolean
    rendererPtyId?: string | null
    adoptedHandle?: boolean
    controllerInventory?: boolean | null
    graphOnlySource?: boolean
    sourceIncarnationId?: string
    stopAndWaitResult?: boolean
  } = {}
) {
  const workspaceId = options.worktreeId ?? (options.folder ? 'folder:folder-1' : WORKTREE_ID)
  let session = persistedSession(includeSource, workspaceId)
  const connectionId = options.connectionId ?? null
  const ownerHostId = connectionId ? `ssh:${connectionId}` : 'local'
  const requestedSessionHostIds: (string | undefined)[] = []
  const repo = {
    id: REPO_ID,
    path: '/workspace',
    displayName: 'repo',
    badgeColor: 'blue',
    addedAt: 1,
    kind: options.repoKind,
    ...(connectionId ? { connectionId } : {})
  }
  const repos = options.repoHosts
    ? options.repoHosts.map((executionHostId) => ({ ...repo, executionHostId }))
    : [repo]
  const folder = options.folder
    ? {
        id: 'folder-1',
        projectGroupId: 'group-1',
        name: 'Local folder',
        folderPath: '/workspace',
        linkedTask: null,
        comment: '',
        isArchived: false,
        isUnread: false,
        isPinned: false,
        sortOrder: 0,
        lastActivityAt: 1,
        createdAt: 1,
        updatedAt: 1,
        ...options.folder
      }
    : null
  const group = {
    id: 'group-1',
    name: 'Local group',
    parentPath: '/workspace',
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1,
    ...options.group
  }
  const store = {
    getRepos: () => repos,
    getFolderWorkspaces: () => (folder ? [folder] : []),
    getProjectGroups: () => [group],
    getWorktreeMeta: () => ({ hostId: options.worktreeHostId }),
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
  const hasPty = vi.fn<() => boolean | null>(() =>
    options.controllerInventory === undefined
      ? !options.graphOnlySource
      : options.controllerInventory
  )
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
  const scope = { id: workspaceId, path: '/workspace', connectionId, repo, folderWorkspace: folder }
  const launchTarget = vi.fn(async () => ({
    scope,
    folderWorkspace: folder,
    managedWorktree: folder ? null : { repoId: REPO_ID, hostId: options.worktreeHostId }
  }))
  Object.assign(runtime, {
    resolveTerminalWorkspaceLaunchScope: vi.fn(async () => scope),
    resolveTerminalWorkspaceLaunchTarget: launchTarget
  })
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill,
    retireRejectedPty,
    ...(options.stopAndWaitResult !== undefined ? { stopAndWait } : {}),
    getForegroundProcess: async () => null,
    hasPty
  })
  runtime.setNotifier({ revealTerminalSession, splitTerminal: rendererSplitTerminal } as never)
  runtime.syncWindowGraph(1, {
    tabs:
      includeSource && options.rendererMounted
        ? [
            {
              tabId: TAB_ID,
              worktreeId: workspaceId,
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
              worktreeId: workspaceId,
              leafId: SOURCE_LEAF_ID,
              paneRuntimeId: 1,
              ptyId: options.rendererPtyId === undefined ? SOURCE_PTY_ID : options.rendererPtyId
            }
          ]
        : [],
    mobileSessionTabs:
      (options.includePairedSnapshot ?? includeSource) ? [remoteSnapshot(workspaceId)] : []
  })
  if (!options.graphOnlySource) {
    runtime.registerPty(
      SOURCE_PTY_ID,
      workspaceId,
      connectionId,
      {
        tabId: TAB_ID,
        leafId: SOURCE_LEAF_ID,
        ...(options.sourceIncarnationId ? { incarnationId: options.sourceIncarnationId } : {})
      },
      false
    )
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test inspects the runtime PTY registry and existing handle issuers.
  const internals = runtime as unknown as {
    issueHandle: (leaf: unknown) => string
    issuePtyHandle: (pty: unknown) => string
    leaves: Map<string, RuntimeLeafRecord>
    handles: Map<string, TerminalHandleRecord>
    mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
    ptysById: Map<string, RuntimePtyWorktreeRecord>
    pairedRendererSessionOwnedPtyIds: Set<string>
  }
  const handle =
    options.graphOnlySource || options.adoptedHandle
      ? internals.issueHandle([...internals.leaves.values()][0])
      : internals.issuePtyHandle(internals.ptysById.get(SOURCE_PTY_ID))
  return {
    runtime,
    handle,
    launchTarget,
    repos,
    folder,
    group,
    source: internals.ptysById.get(SOURCE_PTY_ID),
    setPaired: () => internals.pairedRendererSessionOwnedPtyIds.add(SOURCE_PTY_ID),
    hasPty,
    mutateHandle: (change: string) => {
      const record = internals.handles.get(handle)
      const leaf = [...internals.leaves.values()][0]
      const pty = internals.ptysById.get(SOURCE_PTY_ID)
      if (!record || !leaf || !pty) {
        throw new Error('missing adopted source')
      }
      const changes: Record<string, () => void> = {
        generation: () => Object.assign(record, { ptyGeneration: record.ptyGeneration + 1 }),
        runtime: () => Object.assign(record, { runtimeId: 'another-runtime' }),
        'handle worktree': () => Object.assign(record, { worktreeId: 'another-worktree' }),
        'PTY worktree': () => Object.assign(pty, { worktreeId: 'another-worktree' }),
        'PTY tab': () => Object.assign(pty, { tabId: 'another-tab' }),
        'PTY pane': () => Object.assign(pty, { paneKey: makePaneKey(TAB_ID, SPLIT_LEAF_ID) }),
        'missing PTY': () => {
          internals.ptysById.delete(SOURCE_PTY_ID)
        },
        disconnected: () => Object.assign(pty, { connected: false }),
        'remapped leaf': () => Object.assign(leaf, { ptyId: 'another-pty' })
      }
      changes[change]?.()
    },
    spawn,
    kill,
    retireRejectedPty,
    stopAndWait,
    revealTerminalSession,
    rendererSplitTerminal,
    getSession: () => session,
    getSnapshot: () => internals.mobileSessionTabsByWorktree.get(workspaceId),
    requestedSessionHostIds,
    replaceSourceIncarnation: (incarnationId: string) =>
      runtime.registerPty(SOURCE_PTY_ID, workspaceId, connectionId, {
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

  it('reveals a persisted split while its mounted source is still publishing its PTY binding', async () => {
    const harness = createHarness(true, { rendererMounted: true, rendererPtyId: null })
    await harness.runtime.splitTerminal(harness.handle, { direction: 'vertical' })
    expect(harness.revealTerminalSession).toHaveBeenCalledOnce()
    expect(harness.getSession().terminalLayoutsByTabId[TAB_ID]?.root?.type).toBe('split')
  })

  it('does not reveal a persisted split into a renderer bound to a different PTY', async () => {
    const harness = createHarness(true, { rendererMounted: true, rendererPtyId: 'replacement' })
    await harness.runtime.splitTerminal(harness.handle, { direction: 'vertical' })
    expect(harness.revealTerminalSession).not.toHaveBeenCalled()
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

describe('native local initial split ratio', () => {
  it('advertises the capability only for a ready owning desktop renderer', () => {
    const { runtime } = createHarness()
    const capability = TERMINAL_SPLIT_RATIO_LOCAL_DESKTOP_RUNTIME_CAPABILITY
    expect(runtime.getStatus().capabilities).not.toContain(capability)
    const window = provideDesktop()
    expect(runtime.getStatus().capabilities).toContain(capability)
    window.webContents.isDestroyed = () => true
    expect(runtime.getStatus().capabilities).not.toContain(capability)
    window.webContents.isDestroyed = () => false
    window.isDestroyed = () => true
    expect(runtime.getStatus().capabilities).not.toContain(capability)
    window.isDestroyed = () => false
    runtime.markRendererReloading(1)
    expect(runtime.getStatus().capabilities).not.toContain(capability)
  })

  it.each(
    [{}, { repoKind: 'folder' as const }, { folder: {}, repoHosts: [] }].flatMap((options) => [
      options,
      { ...options, rendererMounted: true, adoptedHandle: true }
    ])
  )('persists and reveals 0.85 for an eligible source: %j', async (options) => {
    provideDesktop()
    const harness = createHarness(true, options)
    harness.revealTerminalSession.mockResolvedValue({ tabId: TAB_ID })
    const split = await harness.runtime.splitTerminal(harness.handle, {
      direction: 'vertical',
      ratio: 0.85,
      command: 'printf startup-once'
    })
    const newLeafId = split.leafId
    if (!newLeafId) {
      throw new Error('split did not return a leaf id')
    }
    const layout = harness.getSession().terminalLayoutsByTabId[TAB_ID]
    expect(layout).toMatchObject({
      root: {
        type: 'split',
        direction: 'vertical',
        ratio: 0.85,
        first: { type: 'leaf', leafId: SOURCE_LEAF_ID },
        second: { type: 'leaf', leafId: split.leafId }
      },
      activeLeafId: split.leafId,
      ptyIdsByLeafId: { [SOURCE_LEAF_ID]: SOURCE_PTY_ID, [newLeafId]: SPLIT_PTY_ID }
    })
    expect(harness.revealTerminalSession).toHaveBeenCalledOnce()
    expect(harness.revealTerminalSession).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        splitRatio: 0.85,
        splitFromLeafId: SOURCE_LEAF_ID,
        leafId: split.leafId
      })
    )
    expect(harness.spawn).toHaveBeenCalledOnce()
    expect(harness.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'printf startup-once',
        commandDelivery: 'provider',
        connectionId: null
      })
    )
    expect(harness.rendererSplitTerminal).not.toHaveBeenCalled()
    const siblings = harness.getSnapshot()?.tabs.filter((tab) => tab.type === 'terminal') ?? []
    expect(siblings).toHaveLength(2)
    for (const sibling of siblings) {
      expect(sibling.parentLayout).toEqual(layout)
    }
  })

  it.each([
    'generation',
    'runtime',
    'handle worktree',
    'PTY worktree',
    'PTY tab',
    'PTY pane',
    'missing PTY',
    'disconnected',
    'remapped leaf'
  ])('refuses an adopted handle with %s before any split mutation', async (change) => {
    provideDesktop()
    const harness = createHarness(true, { rendererMounted: true, adoptedHandle: true })
    const before = structuredClone(harness.getSession())
    harness.mutateHandle(change)
    await expect(harness.runtime.splitTerminal(harness.handle, { ratio: 0.85 })).rejects.toThrow()
    expect(harness.launchTarget).not.toHaveBeenCalled()
    expect(harness.spawn).not.toHaveBeenCalled()
    expect(harness.revealTerminalSession).not.toHaveBeenCalled()
    expect(harness.getSession()).toEqual(before)
  })

  it.each([
    { label: 'SSH PTY', options: { connectionId: 'ssh-1' } },
    { label: 'SSH repo host', options: { repoHosts: ['ssh:box'] } },
    { label: 'runtime repo host', options: { repoHosts: ['runtime:env-1'] } },
    { label: 'malformed repo host', options: { repoHosts: ['runtime:'] } },
    { label: 'ambiguous repo host', options: { repoHosts: ['local', 'runtime:env-1'] } },
    { label: 'unowned repo', options: { repoHosts: [] } },
    { label: 'missing controller inventory', options: { controllerInventory: false } },
    { label: 'unknown controller inventory', options: { controllerInventory: null } },
    { label: 'runtime worktree host', options: { worktreeHostId: 'runtime:env-1' } },
    { label: 'malformed worktree host', options: { worktreeHostId: 'runtime:' } },
    { label: 'floating source', options: { worktreeId: '__floating__' } },
    { label: 'unknown folder', options: { worktreeId: 'folder:missing' } },
    { label: 'folder without project group', options: { folder: { projectGroupId: 'missing' } } },
    { label: 'folder without group root', options: { folder: {}, group: { parentPath: '' } } },
    { label: 'folder without path', options: { folder: { folderPath: '' } } },
    { label: 'SSH folder', options: { folder: { executionHostId: 'ssh:box' } } },
    { label: 'runtime folder', options: { folder: { executionHostId: 'runtime:env-1' } } },
    { label: 'malformed folder', options: { folder: { executionHostId: 'runtime:' } } },
    { label: 'SSH folder group', options: { folder: {}, group: { connectionId: 'box' } } },
    {
      label: 'runtime folder group',
      options: { folder: {}, group: { executionHostId: 'runtime:env-1' } }
    },
    {
      label: 'malformed folder group',
      options: { folder: {}, group: { executionHostId: 'runtime:' } }
    },
    {
      label: 'folder containing runtime repo',
      options: { folder: {}, repoHosts: ['runtime:env-1'] }
    },
    { label: 'renderer-only source', options: { rendererMounted: true, graphOnlySource: true } }
  ])('refuses $label before canonical resolution or mutations', async ({ options }) => {
    provideDesktop()
    const harness = createHarness(true, { ...options, rendererMounted: true, adoptedHandle: true })
    const before = structuredClone(harness.getSession())
    await expect(harness.runtime.splitTerminal(harness.handle, { ratio: 0.85 })).rejects.toThrow()
    expect(harness.launchTarget).not.toHaveBeenCalled()
    expect(harness.spawn).not.toHaveBeenCalled()
    expect(harness.revealTerminalSession).not.toHaveBeenCalled()
    expect(harness.rendererSplitTerminal).not.toHaveBeenCalled()
    expect(harness.getSession()).toEqual(before)
  })

  it.each(['paired', 'WSL', 'headless', 'reloading', 'unbound'] as const)(
    'refuses %s before canonical resolution or mutations',
    async (source) => {
      provideDesktop()
      const harness = createHarness(source !== 'unbound', {
        rendererMounted: source !== 'unbound',
        adoptedHandle: source !== 'unbound'
      })
      if (source === 'paired') {
        harness.setPaired()
      }
      if (source === 'WSL' && harness.source) {
        harness.source.isWsl = true
      }
      if (source === 'headless') {
        setRuntimeDesktopSurface(null)
      }
      if (source === 'reloading') {
        harness.runtime.markRendererReloading(1)
      }
      const before = structuredClone(harness.getSession())
      await expect(harness.runtime.splitTerminal(harness.handle, { ratio: 0.85 })).rejects.toThrow()
      expect(harness.launchTarget).not.toHaveBeenCalled()
      expect(harness.spawn).not.toHaveBeenCalled()
      expect(harness.revealTerminalSession).not.toHaveBeenCalled()
      expect(harness.getSession()).toEqual(before)
    }
  )

  it.each(['ownership', 'generation'])(
    'revalidates %s after canonical resolution before spawn',
    async (change) => {
      provideDesktop()
      const harness = createHarness(true, { rendererMounted: true, adoptedHandle: true })
      const target = await harness.launchTarget()
      harness.launchTarget.mockImplementation(async () => {
        if (change === 'ownership') {
          harness.setPaired()
        } else {
          harness.mutateHandle('generation')
        }
        return target
      })
      await expect(harness.runtime.splitTerminal(harness.handle, { ratio: 0.85 })).rejects.toThrow()
      expect(harness.spawn).not.toHaveBeenCalled()
      expect(harness.revealTerminalSession).not.toHaveBeenCalled()
    }
  )

  it.each(['source', 'ownership', 'window', 'generation', 'remapped leaf', 'inventory'] as const)(
    'retires the new PTY when %s changes during spawn',
    async (change) => {
      const window = provideDesktop()
      const harness = createHarness(true, {
        deferSpawn: true,
        stopAndWaitResult: true,
        rendererMounted: true,
        adoptedHandle: true
      })
      const before = structuredClone(harness.getSession())
      const split = harness.runtime.splitTerminal(harness.handle, { ratio: 0.85 })
      await vi.waitFor(() => expect(harness.spawn).toHaveBeenCalledOnce())
      if (change === 'source') {
        harness.replaceSourceIncarnation('changed')
      }
      if (change === 'ownership') {
        harness.setPaired()
      }
      if (change === 'window') {
        window.isDestroyed = () => true
      }
      if (change === 'generation' || change === 'remapped leaf') {
        harness.mutateHandle(change)
      }
      if (change === 'inventory') {
        harness.hasPty.mockReturnValue(false)
      }
      harness.resolveSpawn()
      await expect(split).rejects.toThrow()
      expect(harness.stopAndWait).toHaveBeenCalledOnce()
      expect(harness.retireRejectedPty).toHaveBeenCalledWith(SPLIT_PTY_ID, true)
      expect(harness.revealTerminalSession).not.toHaveBeenCalled()
      expect(harness.getSession()).toEqual(before)
    }
  )

  it('awaits local reveal and rejects a renderer reload instead of reporting default geometry', async () => {
    provideDesktop()
    const harness = createHarness(true, { deferReveal: true, stopAndWaitResult: true })
    harness.retireRejectedPty.mockImplementation((ptyId, stopped) => {
      if (stopped) {
        void harness.runtime.onPtyExit(ptyId, 0)
      }
    })
    const split = harness.runtime.splitTerminal(harness.handle, { ratio: 0.85 })
    await vi.waitFor(() => expect(harness.revealTerminalSession).toHaveBeenCalledOnce())
    harness.runtime.markRendererReloading(1)
    harness.resolveReveal()
    await expect(split).rejects.toThrow()
    expect(harness.retireRejectedPty).toHaveBeenCalledWith(SPLIT_PTY_ID, true)
    await vi.waitFor(() => {
      expect(harness.getSession().terminalLayoutsByTabId[TAB_ID].root).toEqual(sourceLayout().root)
      expect(
        harness.getSnapshot()?.tabs.flatMap((tab) => (tab.type === 'terminal' ? [tab.ptyId] : []))
      ).toEqual([SOURCE_PTY_ID])
    })
  })
})
