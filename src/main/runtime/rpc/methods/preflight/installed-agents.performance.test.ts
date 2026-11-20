import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../../orca-runtime'
import {
  partialRuntimeStore,
  storeRepo,
  storeWorktreeMeta
} from '../../../construction/test-context/runtime-store-partial-fixture'
import type { WorktreeMeta } from '../../../../../shared/worktree/meta-types'
import type { HostWorktreeTarget } from '../../../../../shared/worktree/host-qualified-identity'
import * as detection from '../../../../preflight/workspace-agent-detection'
import { listInstalledWorkspaceAgents } from './installed-agents'

const scan = vi.hoisted(() => vi.fn())
vi.mock('../../../workspaces/catalog/repo-worktree-resolution-scan', () => ({
  scanLocalRepoWorktreesForResolution: scan
}))
vi.mock('../../../workspaces/catalog/repo-worktree-admin-fingerprint', () => ({
  readRepoWorktreeAdminFingerprint: vi.fn(async () => null)
}))

afterEach(() => vi.restoreAllMocks())

describe('installed-agent workspace resolution bound', () => {
  it.each([750, 7500])('resolves the selected checkout once among %i worktrees', async (count) => {
    const repo = storeRepo({ id: `inventory-${count}`, path: `/work/inventory-${count}` })
    const meta: Record<string, WorktreeMeta> = {}
    scan.mockResolvedValue({
      ok: true,
      worktrees: Array.from({ length: count }, (_, index) => ({
        path: `${repo.path}/${index}`,
        head: 'abc',
        branch: `refs/heads/branch-${index}`,
        isBare: false,
        isMainWorktree: index === 0
      }))
    })
    const runtime = new OrcaRuntimeService(
      partialRuntimeStore({
        getRepos: () => [repo],
        getRepo: (id) => (id === repo.id ? repo : undefined),
        getProjects: () => [],
        getAllWorktreeMeta: () => meta,
        getWorktreeMeta: (id: string) => meta[id],
        setWorktreeMeta: ({ id }: HostWorktreeTarget, changes: Partial<WorktreeMeta>) => {
          meta[id] = { ...storeWorktreeMeta(), ...meta[id], ...changes }
          return meta[id]
        },
        getAllWorktreeLineage: () => ({}),
        getAllWorkspaceLineage: () => ({})
      })
    )
    const resolve = vi.spyOn(runtime, 'showManagedWorktree')
    vi.spyOn(detection, 'detectAgentsOnHost').mockResolvedValue(['codex'])

    const result = await listInstalledWorkspaceAgents(runtime, {
      worktreeId: `${repo.id}::${repo.path}/0`,
      worktreeHostId: 'local'
    })

    expect(result.agents).toEqual(['codex'])
    expect(resolve).toHaveBeenCalledTimes(1)
  })
})
