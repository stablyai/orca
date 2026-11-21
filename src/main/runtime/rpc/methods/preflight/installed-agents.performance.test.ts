import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function checkoutInventory(count: number) {
  const repo = storeRepo({ id: `inventory-${count}`, path: `/work/inventory-${count}` })
  const meta: Record<string, WorktreeMeta> = {}
  for (let index = 0; index < count; index += 1) {
    meta[`${repo.id}::${repo.path}/${index}`] = storeWorktreeMeta({
      hostId: 'local',
      instanceId: `checkout-${index}`
    })
  }
  const readMeta = vi.fn((id: string) => meta[id])
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
      getWorktreeMetaForHost: readMeta,
      setWorktreeMeta: ({ id }: HostWorktreeTarget, changes: Partial<WorktreeMeta>) => {
        meta[id] = { ...storeWorktreeMeta(), ...meta[id], ...changes }
        return meta[id]
      },
      getAllWorktreeLineage: () => ({}),
      getAllWorkspaceLineage: () => ({})
    })
  )
  return { repo, runtime, readMeta }
}

describe('installed-agent workspace resolution bound', () => {
  // #45072 reuses the selected workspace so detection does not read its catalog a second time.
  it.each([750, 7500])('resolves the selected checkout once among %i worktrees', async (count) => {
    const { repo, runtime } = checkoutInventory(count)
    const resolve = vi.spyOn(runtime, 'showManagedWorktree')
    vi.spyOn(detection, 'detectAgentsOnHost').mockResolvedValue(['codex'])

    const result = await listInstalledWorkspaceAgents(runtime, {
      worktreeId: `${repo.id}::${repo.path}/0`,
      worktreeHostId: 'local'
    })

    expect(result).toMatchObject({ agents: ['codex'] })
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  // #45952: a cold missing-id lookup stamped every sibling before the full catalog stamped them again.
  it.each([
    [750, 750],
    [7500, 7500]
  ])('reads metadata once when a checkout is absent among %i worktrees', async (count, reads) => {
    const { repo, runtime, readMeta } = checkoutInventory(count)

    await expect(
      listInstalledWorkspaceAgents(runtime, {
        worktreeId: `${repo.id}::${repo.path}/removed`,
        worktreeHostId: 'local'
      })
    ).rejects.toThrow('selector_not_found')

    expect(readMeta).toHaveBeenCalledTimes(reads)
  })

  it.each([
    [750, 12],
    [7500, 12],
    [750, 120]
  ])('acquires the selected folder once among %i folders and %i groups', async (count, groupCount) => {
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
