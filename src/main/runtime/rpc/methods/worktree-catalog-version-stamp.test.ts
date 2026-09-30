import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { WORKTREE_METHODS } from './worktree'
import {
  bumpLocalWorktreeScanGeneration,
  getLocalWorktreeCatalogVersion
} from '../../../local-worktree-scan-generation'

const repo = {
  id: 'repo-stamp',
  path: '/workspace/repo',
  displayName: 'repo',
  badgeColor: '#000',
  addedAt: 1,
  kind: 'git' as const
}

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

const passthroughDedupe = <T>(_repo: string, _id: string | undefined, run: () => Promise<T>) =>
  run()

function stubRuntime(stub: Record<string, unknown>): OrcaRuntimeService {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the methods under test read only the members each stub provides.
  return stub as unknown as OrcaRuntimeService
}

async function dispatch(runtime: OrcaRuntimeService, method: string, params: unknown) {
  const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })
  let response: unknown
  await dispatcher.dispatchStreaming(makeRequest(method, params), (r: unknown) => {
    // Why: the dispatcher hands the sink the serialized frame.
    response = typeof r === 'string' ? JSON.parse(r) : r
  })
  return response
}

// Why this suite exists: a paired client orders listings against the create and remove replies
// it has applied, so both replies must name the catalog their mutation produced.
describe('worktree mutation replies carry the catalog version', () => {
  it('worktree.create stamps the version current after the create', async () => {
    const runtime = stubRuntime({
      getRuntimeId: () => 'test-runtime',
      dedupeWorktreeCreate: passthroughDedupe,
      showRepo: vi.fn().mockResolvedValue(repo),
      createManagedWorktree: vi.fn(async () => {
        // The create's own change notification bumps the generation before it returns.
        bumpLocalWorktreeScanGeneration(repo.id)
        return { worktree: { id: 'wt-1' } }
      })
    })

    const response = await dispatch(runtime, 'worktree.create', {
      repo: 'repo-stamp',
      name: 'feature'
    })

    expect(response).toMatchObject({
      result: { worktree: { id: 'wt-1' }, catalogVersion: getLocalWorktreeCatalogVersion(repo.id) }
    })
  })

  it('worktree.rm stamps an id selector from its repo without resolving it a second time', async () => {
    const showManagedWorktree = vi.fn()
    const runtime = stubRuntime({
      getRuntimeId: () => 'test-runtime',
      listRepos: () => [repo],
      showManagedWorktree,
      removeManagedWorktree: vi.fn(async () => {
        bumpLocalWorktreeScanGeneration(repo.id)
        return {}
      })
    })

    const stamped = await dispatch(runtime, 'worktree.rm', {
      worktree: `id:${repo.id}::/workspace/wt-1`,
      hostId: 'local'
    })

    expect(stamped).toMatchObject({
      result: { removed: true, catalogVersion: getLocalWorktreeCatalogVersion(repo.id) }
    })
    expect(showManagedWorktree).not.toHaveBeenCalled()
  })

  it('worktree.rm leaves a selector that names no repo unstamped', async () => {
    const runtime = stubRuntime({
      getRuntimeId: () => 'test-runtime',
      listRepos: () => [repo],
      showManagedWorktree: vi.fn().mockResolvedValue({ repoId: repo.id, hostId: 'local' }),
      removeManagedWorktree: vi.fn().mockResolvedValue({})
    })

    const bare = await dispatch(runtime, 'worktree.rm', { worktree: 'path:/workspace/wt-1' })

    expect(bare).toMatchObject({ result: { removed: true } })
    expect(JSON.stringify(bare)).not.toContain('catalogVersion')
  })
})
