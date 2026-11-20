import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../../orca-runtime'
import {
  partialRuntimeStore,
  storeFolderWorkspace,
  storeProjectGroup,
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
  // #45072 reuses the selected workspace so detection does not read its catalog a second time.
  it('resolves the selected checkout once in a large worktree inventory', async () => {
    const count = 7500
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

    expect(result).toMatchObject({ agents: ['codex'] })
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('acquires the selected folder once in a large folder catalog', async () => {
    const count = 7500
    const groupCount = 120
    const folders = Array.from({ length: count }, (_, index) =>
      storeFolderWorkspace({
        id: index === 0 ? 'hub' : `hub-${index}`,
        projectGroupId: 'group',
        folderPath: `/work/hub-${index}`,
        executionHostId: 'local'
      })
    )
    folders.push(
      storeFolderWorkspace({
        id: 'hub',
        projectGroupId: 'group',
        folderPath: '/srv/hub',
        executionHostId: 'ssh:box'
      })
    )
    const readFolders = vi.fn(() => folders)
    const groups = Array.from({ length: groupCount }, (_, index) =>
      storeProjectGroup({ id: index === 0 ? 'group' : `group-${index}` })
    )
    const readGroups = vi.fn(() => groups)
    const runtime = new OrcaRuntimeService(
      partialRuntimeStore({
        getFolderWorkspaces: readFolders,
        getProjectGroups: readGroups
      })
    )
    vi.spyOn(detection, 'detectAgentsOnHost').mockResolvedValue(['codex'])

    const result = await listInstalledWorkspaceAgents(runtime, {
      worktreeId: 'folder:hub',
      worktreeHostId: 'local'
    })

    expect(result).toMatchObject({ agents: ['codex'] })
    expect(readFolders).toHaveBeenCalledTimes(1)
    expect(readGroups).toHaveBeenCalledTimes(1)
  })
})
