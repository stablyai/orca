import { describe, expect, it, vi } from 'vitest'
import {
  FOLDER_WORKSPACE_INSTANCE_SEPARATOR,
  MOCK_GIT_WORKTREES,
  OrcaRuntimeService,
  listWorktrees
} from '../orca-runtime-test-mocks.spec'
import {
  TEST_FOLDER_WORKSPACE_PATH,
  TEST_REPO_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  createRuntime,
  makeWorktreeMeta,
  store
} from '../orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('emits one mobile session terminal tab per live PTY even if two tabs resolve to it', () => {
    const runtime = createRuntime()
    const internals = runtime as unknown as {
      recordPtyWorktree: (
        ptyId: string,
        worktreeId: string,
        state?: Record<string, unknown>
      ) => void
      mobileSessionTabsByWorktree: Map<string, unknown>
      getMobileSessionTabsForWorktree: (worktreeId: string) => {
        tabs: { type: string; terminal?: string | null }[]
      }
    }
    // Two unclaimed live PTYs on the worktree; the worktree-only fallback binds either to a leafless tab that references it.
    internals.recordPtyWorktree('pty-shared', TEST_WORKTREE_ID, { connected: true })
    internals.recordPtyWorktree('pty-other', TEST_WORKTREE_ID, { connected: true })

    const terminalTab = (leafId: string, ptyId: string) => ({
      type: 'terminal' as const,
      id: `term_dup::${leafId}`,
      parentTabId: 'term_dup',
      leafId,
      ptyId,
      title: 'Agent',
      isActive: leafId === 'leaf-new'
    })

    // Two records (stale headless leaf + live leaf) both resolve to the SAME live PTY — the renderer-graph origin the leaf fix can't reach.
    internals.mobileSessionTabsByWorktree.set(TEST_WORKTREE_ID, {
      worktree: TEST_WORKTREE_ID,
      publicationEpoch: 'renderer:test:1',
      snapshotVersion: 1,
      activeGroupId: null,
      activeTabId: 'term_dup::leaf-new',
      activeTabType: 'terminal',
      tabs: [terminalTab('leaf-new', 'pty-shared'), terminalTab('leaf-old', 'pty-shared')]
    })
    const deduped = internals.getMobileSessionTabsForWorktree(TEST_WORKTREE_ID)
    const dedupedTerminals = deduped.tabs.filter((tab) => tab.type === 'terminal')
    expect(dedupedTerminals).toHaveLength(1)
    expect(dedupedTerminals[0].terminal).toBeTruthy()

    // Split siblings own DISTINCT PTYs, so they must never be collapsed.
    internals.mobileSessionTabsByWorktree.set(TEST_WORKTREE_ID, {
      worktree: TEST_WORKTREE_ID,
      publicationEpoch: 'renderer:test:2',
      snapshotVersion: 2,
      activeGroupId: null,
      activeTabId: 'term_dup::leaf-new',
      activeTabType: 'terminal',
      tabs: [terminalTab('leaf-new', 'pty-shared'), terminalTab('leaf-old', 'pty-other')]
    })
    const split = internals.getMobileSessionTabsForWorktree(TEST_WORKTREE_ID)
    expect(split.tabs.filter((tab) => tab.type === 'terminal')).toHaveLength(2)
  })

  it('resolves projected split authority from the parent layout PTY binding', () => {
    const runtime = createRuntime()
    const tabId = 'projected-parent-tab'
    const leafId = 'projected-leaf'
    const ptyId = 'projected-pty'
    const internals = runtime as unknown as {
      mobileSessionTabsByWorktree: Map<string, unknown>
      resolveTerminalSplitSourceAuthority: (
        worktreeId: string,
        tabId: string,
        leafId: string,
        ptyId: string
      ) => { persisted: boolean; rendererMounted: boolean } | null
    }
    internals.mobileSessionTabsByWorktree.set(TEST_WORKTREE_ID, {
      tabs: [
        {
          type: 'terminal',
          parentTabId: tabId,
          leafId,
          ptyId: null,
          parentLayout: { ptyIdsByLeafId: { [leafId]: ptyId } }
        }
      ]
    })

    expect(
      internals.resolveTerminalSplitSourceAuthority(TEST_WORKTREE_ID, tabId, leafId, ptyId)
    ).toMatchObject({ persisted: false, rendererMounted: false })
  })

  it('keeps targeted terminal lists from adopting controller PTYs for other worktrees', async () => {
    vi.mocked(listWorktrees).mockResolvedValue([
      ...MOCK_GIT_WORKTREES,
      {
        path: '/tmp/worktree-b',
        head: 'def',
        branch: 'feature/bar',
        isBare: false,
        isMainWorktree: false
      },
      {
        path: '/tmp/worktree-a/nested',
        head: 'ghi',
        branch: 'feature/nested',
        isBare: false,
        isMainWorktree: false
      }
    ])
    const runtime = createRuntime()
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        { id: 'target-controller-pty', cwd: '/tmp/worktree-a/src', title: 'target' },
        { id: 'other-controller-pty', cwd: '/tmp/worktree-b/src', title: 'other' },
        {
          id: 'repo-1::/tmp/worktree-b@@other-controller-pty',
          cwd: '/tmp/worktree-a/src',
          title: 'prefixed other'
        },
        { id: 'nested-controller-pty', cwd: '/tmp/worktree-a/nested/src', title: 'nested' }
      ]
    })
    runtime.attachWindow(1)
    runtime.markGraphReady(1)

    const terminals = await runtime.listTerminals(`path:${TEST_WORKTREE_PATH}`)

    expect(terminals.terminals).toHaveLength(1)
    expect(terminals.terminals[0]).toMatchObject({
      worktreeId: TEST_WORKTREE_ID,
      worktreePath: TEST_WORKTREE_PATH
    })
    const internals = runtime as unknown as { ptysById: Map<string, unknown> }
    expect(internals.ptysById.has('target-controller-pty')).toBe(true)
    expect(internals.ptysById.has('other-controller-pty')).toBe(false)
    expect(internals.ptysById.has('repo-1::/tmp/worktree-b@@other-controller-pty')).toBe(false)
    expect(internals.ptysById.has('nested-controller-pty')).toBe(false)
  })

  it('keeps explicit-id terminal lists from resolving all worktrees', async () => {
    vi.mocked(listWorktrees).mockClear()
    vi.mocked(listWorktrees).mockRejectedValue(
      new Error('all-worktree resolution should be skipped')
    )
    const runtime = createRuntime()
    const ptyId = `${TEST_WORKTREE_ID}@@daemon-controller-pty`
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        { id: ptyId, cwd: '/unresolved/cwd', title: 'daemon shell' },
        { id: 'cwd-only-pty', cwd: TEST_WORKTREE_PATH, title: 'cwd shell' }
      ]
    })

    const terminals = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)

    expect(listWorktrees).not.toHaveBeenCalled()
    expect(terminals.terminals.map((terminal) => terminal.worktreeId)).toEqual([
      TEST_WORKTREE_ID,
      TEST_WORKTREE_ID
    ])
    const internals = runtime as unknown as { ptysById: Map<string, unknown> }
    expect(internals.ptysById.has(ptyId)).toBe(true)
    expect(internals.ptysById.has('cwd-only-pty')).toBe(true)
  })

  it('matches explicit-id cwd PTYs when the resolved worktree cache is incomplete', async () => {
    vi.mocked(listWorktrees).mockResolvedValueOnce([
      {
        path: '/tmp/worktree-a/nested',
        head: 'ghi',
        branch: 'feature/nested',
        isBare: false,
        isMainWorktree: false
      }
    ])
    const runtime = createRuntime()
    await runtime.listTerminals()
    vi.mocked(listWorktrees).mockClear()
    vi.mocked(listWorktrees).mockRejectedValue(
      new Error('explicit-id fallback should not rescan worktrees')
    )
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        { id: 'cwd-only-pty', cwd: `${TEST_WORKTREE_PATH}/src`, title: 'cwd shell' },
        { id: 'nested-controller-pty', cwd: `${TEST_WORKTREE_PATH}/nested/src`, title: 'nested' }
      ]
    })

    const terminals = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)

    expect(listWorktrees).not.toHaveBeenCalled()
    expect(terminals.terminals.map((terminal) => terminal.worktreeId)).toEqual([TEST_WORKTREE_ID])
    const internals = runtime as unknown as { ptysById: Map<string, unknown> }
    expect(internals.ptysById.has('cwd-only-pty')).toBe(true)
    expect(internals.ptysById.has('nested-controller-pty')).toBe(false)
  })

  it('keeps explicit-id cold-cache terminal lists from adopting nested worktree PTYs', async () => {
    const nestedWorktreeId = `${TEST_REPO_ID}::${TEST_WORKTREE_PATH}/nested`
    vi.mocked(listWorktrees).mockClear()
    vi.mocked(listWorktrees).mockRejectedValue(
      new Error('explicit-id fallback should not rescan worktrees')
    )
    const runtime = new OrcaRuntimeService({
      ...store,
      getAllWorktreeMeta: () => ({
        [TEST_WORKTREE_ID]: store.getAllWorktreeMeta()[TEST_WORKTREE_ID],
        [nestedWorktreeId]: makeWorktreeMeta()
      }),
      getWorktreeMeta: (worktreeId: string) =>
        ({
          [TEST_WORKTREE_ID]: store.getAllWorktreeMeta()[TEST_WORKTREE_ID],
          [nestedWorktreeId]: makeWorktreeMeta()
        })[worktreeId]
    })
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        { id: 'cwd-only-pty', cwd: `${TEST_WORKTREE_PATH}/src`, title: 'cwd shell' },
        { id: 'nested-controller-pty', cwd: `${TEST_WORKTREE_PATH}/nested/src`, title: 'nested' }
      ]
    })

    const terminals = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)

    expect(listWorktrees).not.toHaveBeenCalled()
    expect(terminals.terminals.map((terminal) => terminal.worktreeId)).toEqual([TEST_WORKTREE_ID])
    const internals = runtime as unknown as { ptysById: Map<string, unknown> }
    expect(internals.ptysById.has('cwd-only-pty')).toBe(true)
    expect(internals.ptysById.has('nested-controller-pty')).toBe(false)
  })

  it('keeps explicit-id cold-cache terminal lists from classifying unrelated same-repo worktrees', async () => {
    const siblingWorktreePath = '/tmp/worktree-sibling'
    const siblingWorktreeId = `${TEST_REPO_ID}::${siblingWorktreePath}`
    vi.mocked(listWorktrees).mockClear()
    vi.mocked(listWorktrees).mockRejectedValue(
      new Error('explicit-id fallback should not rescan worktrees')
    )
    const runtime = new OrcaRuntimeService({
      ...store,
      getAllWorktreeMeta: () => ({
        [TEST_WORKTREE_ID]: store.getAllWorktreeMeta()[TEST_WORKTREE_ID],
        [siblingWorktreeId]: makeWorktreeMeta()
      }),
      getWorktreeMeta: (worktreeId: string) =>
        ({
          [TEST_WORKTREE_ID]: store.getAllWorktreeMeta()[TEST_WORKTREE_ID],
          [siblingWorktreeId]: makeWorktreeMeta()
        })[worktreeId]
    })
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        { id: 'target-cwd-pty', cwd: `${TEST_WORKTREE_PATH}/src`, title: 'target' },
        { id: 'sibling-cwd-pty', cwd: `${siblingWorktreePath}/src`, title: 'sibling' }
      ]
    })

    const terminals = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)

    expect(listWorktrees).not.toHaveBeenCalled()
    expect(terminals.terminals.map((terminal) => terminal.worktreeId)).toEqual([TEST_WORKTREE_ID])
    const internals = runtime as unknown as { ptysById: Map<string, unknown> }
    expect(internals.ptysById.has('target-cwd-pty')).toBe(true)
    expect(internals.ptysById.has('sibling-cwd-pty')).toBe(false)
  })

  it('ignores cwd-only controller PTYs for malformed explicit worktree IDs', async () => {
    vi.mocked(listWorktrees).mockClear()
    vi.mocked(listWorktrees).mockRejectedValue(
      new Error('malformed explicit-id fallback should not rescan worktrees')
    )
    const runtime = createRuntime()
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        { id: 'cwd-only-pty', cwd: `${TEST_WORKTREE_PATH}/src`, title: 'cwd shell' }
      ]
    })

    const terminals = await runtime.listTerminals(`id:${TEST_REPO_ID}::`)

    expect(listWorktrees).not.toHaveBeenCalled()
    expect(terminals.terminals).toEqual([])
    const internals = runtime as unknown as { ptysById: Map<string, unknown> }
    expect(internals.ptysById.has('cwd-only-pty')).toBe(false)
  })

  it('keeps unknown bare terminal-list ids on the no-scan exact-id path', async () => {
    vi.mocked(listWorktrees).mockClear()
    vi.mocked(listWorktrees).mockRejectedValue(
      new Error('unknown explicit ids should not rescan worktrees')
    )
    const runtime = createRuntime()

    await expect(runtime.listTerminals('id:not-a-repo')).resolves.toMatchObject({
      terminals: [],
      totalCount: 0
    })
    expect(listWorktrees).not.toHaveBeenCalled()
  })

  it('matches explicit-id cwd PTYs for folder workspace instance IDs', async () => {
    const folderWorktreeId = `${TEST_REPO_ID}::${TEST_FOLDER_WORKSPACE_PATH}${FOLDER_WORKSPACE_INSTANCE_SEPARATOR}11111111-1111-4111-8111-111111111111`
    vi.mocked(listWorktrees).mockClear()
    vi.mocked(listWorktrees).mockRejectedValue(
      new Error('folder explicit-id fallback should not rescan worktrees')
    )
    const runtime = createRuntime()
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        { id: 'folder-cwd-pty', cwd: `${TEST_FOLDER_WORKSPACE_PATH}/src`, title: 'folder shell' }
      ]
    })

    const terminals = await runtime.listTerminals(`id:${folderWorktreeId}`)

    expect(listWorktrees).not.toHaveBeenCalled()
    expect(terminals.terminals.map((terminal) => terminal.worktreeId)).toEqual([folderWorktreeId])
    expect(terminals.terminals[0]?.worktreePath).toBe(TEST_FOLDER_WORKSPACE_PATH)
  })

  it('keeps same-path folder workspace instance PTYs scoped to their exact ids', async () => {
    const firstWorktreeId = `${TEST_REPO_ID}::${TEST_FOLDER_WORKSPACE_PATH}${FOLDER_WORKSPACE_INSTANCE_SEPARATOR}11111111-1111-4111-8111-111111111111`
    const secondWorktreeId = `${TEST_REPO_ID}::${TEST_FOLDER_WORKSPACE_PATH}${FOLDER_WORKSPACE_INSTANCE_SEPARATOR}22222222-2222-4222-8222-222222222222`
    vi.mocked(listWorktrees).mockClear()
    vi.mocked(listWorktrees).mockRejectedValue(
      new Error('folder explicit-id fallback should not rescan worktrees')
    )
    const runtime = createRuntime()
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        {
          id: 'first-folder-pty',
          cwd: TEST_FOLDER_WORKSPACE_PATH,
          title: 'first',
          worktreeId: firstWorktreeId
        },
        {
          id: 'second-folder-pty',
          cwd: TEST_FOLDER_WORKSPACE_PATH,
          title: 'second',
          worktreeId: secondWorktreeId
        }
      ]
    })

    const terminals = await runtime.listTerminals(`id:${secondWorktreeId}`)

    expect(listWorktrees).not.toHaveBeenCalled()
    expect(terminals.terminals).toHaveLength(1)
    expect(terminals.terminals[0]).toMatchObject({
      ptyId: 'second-folder-pty',
      worktreeId: secondWorktreeId,
      worktreePath: TEST_FOLDER_WORKSPACE_PATH
    })
    const internals = runtime as unknown as {
      ptysById: Map<string, { worktreeId: string }>
    }
    expect(internals.ptysById.get('first-folder-pty')).toBeUndefined()
    expect(internals.ptysById.get('second-folder-pty')?.worktreeId).toBe(secondWorktreeId)
  })

  it('routes PTY output through the PTY leaf index in large terminal graphs', () => {
    const runtime = new OrcaRuntimeService(store)
    const liveLeafCount = 2773
    const targetIndex = liveLeafCount - 17
    const tabs = Array.from({ length: liveLeafCount }, (_, index) => ({
      tabId: `tab-${index}`,
      worktreeId: `repo-1::/tmp/worktree-${index}`,
      title: `Terminal ${index}`,
      activeLeafId: 'pane:1',
      layout: null
    }))
    const leaves = Array.from({ length: liveLeafCount }, (_, index) => ({
      tabId: `tab-${index}`,
      worktreeId: `repo-1::/tmp/worktree-${index}`,
      leafId: 'pane:1',
      paneRuntimeId: 1,
      ptyId: `pty-${index}`
    }))

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs, leaves })

    const runtimePrivate = runtime as unknown as {
      leaves: Map<string, unknown>
      leavesByPtyId: Map<string, { preview?: string; lastOutputAt?: number | null }[]>
    }
    const originalLeaves = runtimePrivate.leaves
    runtimePrivate.leaves = new Proxy(originalLeaves, {
      get(target, prop) {
        if (
          prop === 'values' ||
          prop === 'entries' ||
          prop === 'keys' ||
          prop === Symbol.iterator
        ) {
          return () => {
            throw new Error('onPtyData should use the PTY leaf index')
          }
        }
        const value = Reflect.get(target, prop, target)
        return typeof value === 'function' ? value.bind(target) : value
      }
    }) as Map<string, unknown>

    runtime.onPtyData(`pty-${targetIndex}`, 'hello indexed\n', 123)

    const [targetLeaf] = runtimePrivate.leavesByPtyId.get(`pty-${targetIndex}`) ?? []
    expect(targetLeaf).toMatchObject({
      preview: 'hello indexed',
      lastOutputAt: 123
    })
    expect(runtime.getStatus().liveLeafCount).toBe(liveLeafCount)
  })
})
