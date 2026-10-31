import { vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { GitWorktreeInfo } from '../../../../shared/worktree/types'
import type { RuntimeWorktreeScanResult } from '../../../runtime/repo-worktree-resolution-scan'
import type { Store as StoreType } from '../../../persistence/loading-store/store'
import { getDefaultSettings, getDefaultWorkspaceSession } from '../../../../shared/constants'
import { storeWorktreeMeta } from '../../../runtime/runtime-store-partial-fixture'
import { OrcaRuntimeService } from '../../../runtime/orca-runtime'

export const repo: Repo = {
  id: 'r',
  path: '/repo',
  displayName: 'repo',
  addedAt: 1,
  badgeColor: 'blue'
}
export const child = '/work/feature'
export const childId = `r::${child}`
export const oid = 'a'.repeat(40)
export function row(path = repo.path): GitWorktreeInfo {
  return {
    path,
    head: oid,
    branch: 'refs/heads/feature',
    isMainWorktree: path === repo.path,
    isBare: false
  }
}
export function fixture(repos = [repo], paths = [child]) {
  let stateWrite: Parameters<StoreType['onStateWritten']>[0] = () => {}
  let sessionWrite: Parameters<StoreType['onWorkspaceSessionWritten']>[0] = () => {}
  const session = {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: Object.fromEntries(paths.map((path) => [`r::${path}`, []]))
  }
  const meta = Object.fromEntries(
    paths.map((path) => [
      `r::${path}`,
      storeWorktreeMeta({
        hostId: 'local',
        instanceId: path,
        displayName: `Saved ${path}`,
        linkedPR: 42
      })
    ])
  )
  const store: StoreType = Object.create(null)
  Object.assign(store, {
    getRepos: () => repos,
    getRepo: (id: string) => repos.find((repo) => repo.id === id),
    getProjects: () => [],
    getProjectHostSetups: () => [],
    getSettings: () => getDefaultSettings('/fixture'),
    getWorkspaceSession: () => session,
    getAllWorktreeMeta: () => meta,
    getAllWorktreeMetaForHost: () => meta,
    getWorktreeMeta: (id: string) => meta[id],
    getWorktreeMetaForHost: (id: string) => meta[id],
    setWorktreeMeta: vi.fn(({ id }, updates) => {
      const next = (meta[id] = storeWorktreeMeta({ ...meta[id], instanceId: id, ...updates }))
      stateWrite(['worktreeMeta'])
      return next
    }),
    getAllWorktreeLineage: () => ({}),
    getAllWorkspaceLineage: () => ({}),
    captureNativeLocalWorktreeMetadataScanExpectation: () => undefined,
    onStateWritten: (listener: typeof stateWrite) => {
      stateWrite = listener
      return () => {}
    },
    onWorkspaceSessionWritten: (listener: typeof sessionWrite) => {
      sessionWrite = listener
      return () => {}
    }
  } satisfies Partial<StoreType>)
  return {
    store,
    meta,
    session,
    changed: () => {
      stateWrite(['worktreeMeta'])
      sessionWrite('local')
    }
  }
}
export class Runtime extends OrcaRuntimeService {
  raw = vi.fn(async (_repo: Repo): Promise<RuntimeWorktreeScanResult> => ({
    ok: true,
    worktrees: [row()]
  }))
  protected override listRepoWorktreesForResolution(target: Repo) {
    return this.raw(target)
  }
  listing(target = repo, signal?: AbortSignal) {
    return this.listRepoWorktreesForListing(target, undefined, signal)
  }
  rows() {
    return this.computeResolvedWorktrees()
  }
  memory() {
    return this.projectCachedWorktrees()
  }
  scoped(id: string) {
    return this.resolveExplicitWorktreeIdScoped(id, 'local')
  }
}
