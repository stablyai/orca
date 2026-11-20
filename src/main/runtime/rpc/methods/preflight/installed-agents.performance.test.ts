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
import { resolveQualifiedAgentDetectionHost } from './preflight-workspace-target'
import * as worktreeRouting from '../../../workspaces/catalog/worktree-launch-host-repo'

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

    expect(result).toMatchObject({ agents: ['codex'] })
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it.each([12, 120])('builds the detection owner index once among %i repos', async (count) => {
    const repos = Array.from({ length: count }, (_, index) =>
      storeRepo({ id: `repo-${index}`, path: `/work/repo-${index}` })
    )
    const runtime = new OrcaRuntimeService(partialRuntimeStore({ getRepos: () => repos }))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: detection reads only the selected row's ownership and path.
    const selected = { repoId: 'repo-0', path: '/work/repo-0', hostId: 'local' } as Awaited<
      ReturnType<OrcaRuntimeService['showManagedWorktree']>
    >
    const routing = vi.spyOn(worktreeRouting, 'resolveWorktreeHostRouting')

    const host = await resolveQualifiedAgentDetectionHost(
      runtime,
      { worktreeId: 'repo-0::/work/repo-0', worktreeHostId: 'local' },
      selected
    )

    expect(host.kind).toBe('local')
    expect(routing).toHaveBeenCalledTimes(1)
  })

  it.each([
    [750, 12],
    [7500, 120]
  ])('acquires the selected folder once among %i folders', async (count, groupCount) => {
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
    const runtime = new OrcaRuntimeService(
      partialRuntimeStore({
        getFolderWorkspaces: readFolders,
        getProjectGroups: () =>
          Array.from({ length: groupCount }, (_, index) =>
            storeProjectGroup({ id: index === 0 ? 'group' : `group-${index}` })
          )
      })
    )
    vi.spyOn(detection, 'detectAgentsOnHost').mockResolvedValue(['codex'])

    const result = await listInstalledWorkspaceAgents(runtime, {
      worktreeId: 'folder:hub',
      worktreeHostId: 'local'
    })

    expect(result).toMatchObject({ agents: ['codex'] })
    expect(readFolders).toHaveBeenCalledTimes(1)
  })
})
