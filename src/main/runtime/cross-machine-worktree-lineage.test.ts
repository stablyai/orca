import { OrchestrationDb } from './orchestration/db'
import { mergeWorktreeMetaForWrite } from '../persistence/loading-store/worktree-meta-write-normalization'
import { describe, expect, it, vi } from 'vitest'
import { mergeWorktree } from '../ipc/worktree-metadata-merge'
import type { WorktreeLineage } from '../../shared/worktree/lineage-types'
import type { RuntimeStore } from './runtime-store-contract'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'
import { RuntimeWorktreeLineageController } from './runtime-worktree-lineage-controller'
import { resolveRuntimeWorktreeCreateLineage } from './runtime-worktree-lineage-resolution'
import { updateRuntimeManagedWorktreeMetadata } from './runtime-managed-worktree-metadata'
import { recordCreatedWorktreeLineage } from './runtime-worktree-lineage-recording'
function row(id: string): ResolvedWorktree {
  const git = { path: `/${id}`, head: '', branch: id, isBare: false, isMainWorktree: false }
  return {
    ...mergeWorktree(
      'repo',
      git,
      mergeWorktreeMetaForWrite(undefined, { instanceId: id, hostId: 'local', sortOrder: 0 })
    ),
    id,
    git,
    parentWorktreeId: null,
    childWorktreeIds: [],
    lineage: null
  }
}
function edge(child: string, parent: string, external = false): WorktreeLineage {
  return {
    worktreeId: child,
    worktreeInstanceId: child,
    parentWorktreeId: parent,
    parentWorktreeInstanceId: parent,
    ...(external ? { parentStore: 'external' as const } : {}),
    origin: 'cli',
    capture: { source: 'explicit-cli-flag', confidence: 'explicit' },
    createdAt: 1
  }
}
function setup(links: Record<string, WorktreeLineage>) {
  const store = {
    getRepo: () => undefined,
    addRepo: vi.fn<RuntimeStore['addRepo']>(),
    updateRepo: vi.fn<RuntimeStore['updateRepo']>(),
    removeWorktreeMeta: vi.fn<RuntimeStore['removeWorktreeMeta']>(),
    getGitHubCache: vi.fn<RuntimeStore['getGitHubCache']>(),
    getSettings: () => ({
      workspaceDir: '',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      branchPrefix: 'none',
      branchPrefixCustom: ''
    }),
    getAllWorktreeMeta: () =>
      Object.fromEntries(
        [
          ...new Set([
            'C',
            'P',
            'Q',
            'R',
            ...Object.values(links).flatMap((e) => [e.worktreeId, e.parentWorktreeId])
          ])
        ].map((id) => [id, row(id)])
      ),
    getAllWorktreeLineage: () => links,
    getWorktreeMeta: (id: string) => row(id),
    getRepos: () => [],
    getWorktreeLineage: (id: string) => links[id],
    getAllWorkspaceLineage: () => ({}),
    setWorktreeMeta: vi.fn<RuntimeStore['setWorktreeMeta']>(),
    removeWorktreeLineage: vi.fn(),
    setWorktreeLineage: vi.fn((_target, lineage: WorktreeLineage) => lineage),
    setWorkspaceLineage: vi.fn<NonNullable<RuntimeStore['setWorkspaceLineage']>>(
      (lineage) => lineage
    )
  } satisfies RuntimeStore
  const controller = new RuntimeWorktreeLineageController({
    getStore: () => store,
    getDb: () => null,
    resolveWorktree: async (id) => row(id),
    listResolvedWorktrees: async () => [],
    showTerminal: async () => ({ worktreeId: 'parent' })
  })
  return { controller, store }
}
describe('cross-machine lineage writes', () => {
  it('follows renamed saved ancestors and permits an unrelated saved cycle', () => {
    const renamed = { ...row('renamed'), instanceId: 'Q' }
    const links = {
      P: edge('P', 'old'),
      renamed: { ...edge('Q', 'R', true), worktreeId: 'renamed' }
    }
    links.P.parentWorktreeInstanceId = 'Q'
    const { store, controller } = setup(links)
    Object.assign(store, { getAllWorktreeMeta: () => ({ C: row('C'), P: row('P'), renamed }) })
    expect(() => controller.validateParent(row('C'), row('P'))).toThrow(
      'chain reaches another Orca install'
    )
    links.renamed = {
      ...links.renamed,
      parentStore: undefined,
      parentWorktreeId: 'P',
      parentWorktreeInstanceId: 'P'
    }
    expect(() => controller.validateParent(row('C'), row('P'))).not.toThrow()
  })
  it('records a caller-resolved external parent without resolving that parent on the child server', async () => {
    const resolveParent = vi.fn()
    const resolution = await resolveRuntimeWorktreeCreateLineage(
      {
        parentWorktreeRef: {
          worktreeId: 'desktop-parent',
          instanceId: 'desktop-instance',
          external: true
        }
      },
      {
        resolveParent,
        resolveWorktreeParent: resolveParent,
        resolveTaskCandidate: vi.fn(),
        resolveCaller: vi.fn()
      }
    )
    const { store } = setup({})
    const recorded = recordCreatedWorktreeLineage(store, row('server-child'), resolution)
    expect(resolveParent).not.toHaveBeenCalled()
    expect(recorded.lineage).toMatchObject({
      parentStore: 'external',
      parentWorktreeId: 'desktop-parent',
      parentWorktreeInstanceId: 'desktop-instance'
    })
    expect(recorded.workspaceLineage).toMatchObject({
      parentStore: 'external',
      parentInstanceId: 'desktop-instance'
    })
  })
  it('refuses both reparentings that could close the four-node cross-store cycle, and allows identical reassertion', () => {
    const externalAncestry = 'chain reaches another Orca install'
    const cases: [Record<string, WorktreeLineage>, string, string, string][] = [
      [{ Q: edge('Q', 'R', true) }, 'P', 'Q', externalAncestry],
      [{ C: edge('C', 'P', true) }, 'R', 'C', externalAncestry],
      [{ Q: edge('Q', 'R'), R: edge('R', 'C', true) }, 'P', 'Q', externalAncestry],
      [{ C: edge('C', 'P', true), P: edge('P', 'C') }, 'C', 'P', 'cycle'],
      [{ Q: edge('Q', 'P') }, 'P', 'Q', 'cycle'],
      [{ C: edge('C', 'P'), P: edge('P', 'Q'), Q: edge('Q', 'C') }, 'C', 'Q', 'cycle']
    ]
    for (const [links, child, parent, error] of cases) {
      expect(() => setup(links).controller.validateParent(row(child), row(parent))).toThrow(error)
    }
    const { controller } = setup({ C: edge('C', 'P', true) })
    expect(() => controller.validateParent(row('C'), row('P'))).not.toThrow()
    expect(() =>
      controller.validateParent(row('C'), { ...row('P'), hostId: 'runtime:server' })
    ).not.toThrow()
  })
  it('follows a legacy folder link in the saved chain before refusing external ancestry', () => {
    const { store, controller } = setup({ Q: edge('Q', 'R', true) })
    Object.assign(store, {
      getFolderWorkspaces: () => [{ id: 'F' }],
      getAllWorkspaceLineage: () => ({
        'folder:F': {
          childWorkspaceKey: 'folder:F',
          parentWorkspaceKey: 'worktree:Q',
          childInstanceId: null,
          parentInstanceId: 'Q'
        }
      })
    })
    expect(() => controller.validateParent(row('P'), row('folder:F'))).toThrow(
      'chain reaches another Orca install'
    )
  })
  it('uses the selected parent saved-null authority instead of another host raw external edge', async () => {
    const { store, controller } = setup({ P: edge('P', 'Q', true) })
    Object.assign(store, {
      getAllWorktreeMeta: () => ({ C: row('C'), P: { ...row('P'), hostId: 'ssh:owner' } }),
      getWorktreeLineageMetadata: () => [
        { id: 'C', meta: row('C') },
        { id: 'P', meta: { ...row('P'), hostId: 'local' as const } },
        { id: 'P', meta: { ...row('P'), hostId: 'ssh:owner' as const } }
      ]
    })
    const parent = { ...row('P'), savedLineage: null }
    const child = row('C')
    const resolveWorktree = vi.fn(async (selector: string) =>
      selector === 'id:P' ? parent : child
    )
    await updateRuntimeManagedWorktreeMetadata({
      selector: 'id:C',
      updates: {
        lineage: { parentWorktreeRef: { worktreeId: 'P', instanceId: 'P', external: false } }
      },
      store,
      ports: {
        resolveWorktree,
        validateParent: (c, p) => controller.validateParent(c, p),
        invalidateResolved: vi.fn(),
        invalidateScan: vi.fn(),
        notifyChanged: vi.fn(),
        showWorktree: async () => child
      }
    })
    expect(resolveWorktree).toHaveBeenCalledWith('id:P', 'P')
    expect(store.setWorktreeLineage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ parentWorktreeId: 'P' })
    )
    expect(() => controller.validateParent(child, { ...row('P'), hostId: 'ssh:owner' })).toThrow(
      'chain reaches another Orca install'
    )
  })
  it('reasserts an external parent without looking it up, refuses a different one, and always clears it', async () => {
    const { store } = setup({ C: edge('C', 'P', true) })
    const child = row('C')
    const ports = {
      resolveWorktree: vi.fn(async () => child),
      validateParent: vi.fn(),
      invalidateResolved: vi.fn(),
      invalidateScan: vi.fn(),
      notifyChanged: vi.fn(),
      showWorktree: vi.fn(async () => child)
    }
    const update = (lineage: {
      parentWorktreeRef?: { worktreeId: string; instanceId: string; external: boolean }
      noParent?: boolean
    }) =>
      updateRuntimeManagedWorktreeMetadata({ selector: 'id:C', updates: { lineage }, store, ports })
    const ref = (id: string, external = true) => ({
      parentWorktreeRef: { worktreeId: id, instanceId: id, external }
    })
    await update(ref('P'))
    expect(ports.resolveWorktree).toHaveBeenCalledTimes(1)
    expect(store.setWorktreeLineage).not.toHaveBeenCalled()
    await expect(update(ref('Q'))).rejects.toThrow('chain reaches another Orca install')
    await update({ noParent: true })
    expect(store.removeWorktreeLineage).toHaveBeenCalledOnce()
    ports.resolveWorktree.mockImplementation(async (id?: string) => row(id === 'id:P' ? 'P' : 'C'))
    await update(ref('P', false))
    expect(ports.validateParent).toHaveBeenCalledWith(row('C'), row('P'))
    expect(store.setWorktreeLineage).toHaveBeenCalledWith(
      expect.anything(),
      expect.not.objectContaining({ parentStore: 'external' })
    )
  })
})

it.each([10, 100])(
  'hydrates through cheap admission and one lazy current corpus per saved synchronous segment at N=%i',
  async (n) => {
    const db = new OrchestrationDb(':memory:')
    try {
      const task = db.createTask({
        runId: 'run_legacy_local',
        spec: 'Recover',
        createdByTerminalHandle: 'term-parent'
      })
      const { store } = setup({})
      let rows = Array.from({ length: n }, (_, i) => ({ ...row(`C${i}`), comment: '' }))
      const metadata = vi.fn(() => Object.fromEntries(rows.map((r) => [r.id, r])))
      const showTerminal = vi.fn(async () => ({ worktreeId: 'P' }))
      Object.assign(store, { getAllWorktreeMeta: metadata })
      const controller = new RuntimeWorktreeLineageController({
        getStore: () => store,
        getDb: () => db,
        listResolvedWorktrees: async () => rows,
        resolveWorktree: async () => row('P'),
        showTerminal
      })
      await controller.listWorktreeLineage()
      expect(metadata).not.toHaveBeenCalled()
      rows = rows.map((r) => ({ ...r, comment: 'task_missing' }))
      await controller.listWorkspaceLineage()
      expect(metadata).not.toHaveBeenCalled()
      const noHandle = db.createTask({ runId: 'run_legacy_local', spec: 'No terminal' })
      rows = rows.map((r) => ({ ...r, comment: noHandle.id }))
      await controller.hydrate()
      expect(metadata).not.toHaveBeenCalled()
      rows = rows.map((r) => ({ ...r, comment: task.id, instanceId: undefined }))
      await controller.hydrate()
      expect(metadata).not.toHaveBeenCalled()
      rows = rows.map((r) => ({ ...r, instanceId: r.id }))
      Object.assign(store, {
        getAllWorktreeLineage: () => Object.fromEntries(rows.map((r) => [r.id, edge(r.id, 'P')]))
      })
      const some = Array.prototype.some
      let rowVisits = 0
      const membership = vi.spyOn(Array.prototype, 'some').mockImplementation(function (
        this: unknown[],
        predicate,
        thisArg
      ) {
        return some.call(this, (value, index, array) => {
          if (value && typeof value === 'object' && 'instanceId' in value && 'id' in value) {
            rowVisits++
          }
          return predicate.call(thisArg, value, index, array)
        })
      })
      try {
        await controller.listWorktreeLineage()
      } finally {
        membership.mockRestore()
      }
      expect(rowVisits).toBe(0)
      expect(metadata).toHaveBeenCalledOnce()
      expect(showTerminal).not.toHaveBeenCalled()
      expect(store.setWorktreeLineage).not.toHaveBeenCalled()
    } finally {
      db.close()
    }
  }
)

it.each([
  'recover',
  'edge during await',
  'replacement',
  'null then recover',
  'clear later',
  'setter clears later'
] as const)(
  'reacquires real task hydration authority after awaits and setters: %s',
  async (mode) => {
    const db = new OrchestrationDb(':memory:')
    try {
      const task = db.createTask({
        runId: 'run_legacy_local',
        spec: 'Recover',
        createdByTerminalHandle: 'term-parent'
      })
      const child = { ...row('C'), comment: task.id }
      const next = { ...row('Q'), comment: task.id }
      const parent = row('P')
      const links: Record<string, WorktreeLineage> = {}
      if (mode === 'clear later' || mode === 'setter clears later') {
        links.Q = edge('Q', 'P')
      }
      const { store } = setup(links)
      let meta = { C: child, Q: next, P: parent }
      const capture = vi.fn(() => meta)
      Object.assign(store, { getAllWorktreeMeta: capture })
      let calls = 0
      const showTerminal = vi.fn(async () => {
        calls++
        if (calls === 1) {
          if (mode === 'clear later') {
            delete links.Q
          }
          if (mode === 'edge during await') {
            links.C = edge('C', 'P', true)
          }
          if (mode === 'replacement') {
            meta = { ...meta, C: { ...child, instanceId: 'replacement' } }
          }
          if (mode === 'null then recover') {
            meta = { ...meta }
            throw new Error('terminal gone')
          }
        }
        return { worktreeId: 'P' }
      })
      const write = vi.mocked(store.setWorktreeLineage).mockImplementation((_target, value) => {
        links[value.worktreeId] = value
        if (mode === 'setter clears later' && value.worktreeId === 'C') {
          delete links.Q
        }
        meta = { ...meta }
        return value
      })
      const controller = new RuntimeWorktreeLineageController({
        getStore: () => store,
        getDb: () => db,
        listResolvedWorktrees: async () => [child, next],
        resolveWorktree: async () => parent,
        showTerminal
      })
      await controller.hydrate()
      const written = write.mock.calls.map(([, value]) => value.worktreeId)
      const recoversBoth =
        mode === 'recover' || mode === 'clear later' || mode === 'setter clears later'
      expect(written).toEqual(recoversBoth ? ['C', 'Q'] : ['Q'])
      expect(capture.mock.calls.length).toBe(recoversBoth ? 4 : 3)
      expect(links.Q).toMatchObject({ parentWorktreeId: 'P', taskId: task.id })
      if (mode === 'edge during await') {
        expect(links.C?.parentStore).toBe('external')
      }
    } finally {
      db.close()
    }
  }
)
