import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../../orca-runtime'
import {
  partialRuntimeStore,
  storeFolderWorkspace,
  storeProject,
  storeProjectGroup,
  storeRepo
} from '../../../construction/test-context/runtime-store-partial-fixture'
import * as detection from '../../../../preflight/workspace-agent-detection'
import { listInstalledWorkspaceAgents } from './installed-agents'
import { resolveQualifiedAgentDetectionHost } from './preflight-workspace-target'

afterEach(() => vi.restoreAllMocks())

function folderRuntime(connectionId: string | null, repoCount: number) {
  const folder = storeFolderWorkspace({
    id: 'hub',
    projectGroupId: 'group',
    folderPath: '/work/hub',
    executionHostId: 'local',
    connectionId
  })
  const repos = Array.from({ length: repoCount }, (_, index) =>
    storeRepo({ id: `repo-${index}`, path: `/work/hub/repo-${index}` })
  )
  return new OrcaRuntimeService(
    partialRuntimeStore({
      getFolderWorkspaces: () => [folder, { ...folder, executionHostId: 'ssh:box' }],
      getProjectGroups: () => [storeProjectGroup({ id: 'group' })],
      getRepos: () => repos,
      getProjects: () => [
        storeProject({
          id: 'project',
          sourceRepoIds: ['repo-0'],
          localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
        })
      ]
    })
  )
}

describe('installed agents for acquired folder workspaces', () => {
  it.each([
    { connectionId: 'box', repoCount: 1, agents: ['claude'] },
    { connectionId: null, repoCount: 1, agents: ['codex'] },
    { connectionId: null, repoCount: 2, agents: ['claude'] },
    { connectionId: null, repoCount: 0, agents: ['claude'] }
  ])(
    'preserves candidate association for $connectionId and $repoCount repos',
    async ({ connectionId, repoCount, agents }) => {
      const runtime = folderRuntime(connectionId, repoCount)
      vi.spyOn(detection, 'detectAgentsOnHost').mockImplementation(async (host) =>
        host.kind === 'local' && host.context?.projectRuntime ? ['codex'] : ['claude']
      )

      const result = await listInstalledWorkspaceAgents(runtime, {
        worktreeId: 'folder:hub',
        worktreeHostId: 'local'
      })

      expect(result).toMatchObject({ agents })
    }
  )

  it('refuses an unqualified duplicate folder id', async () => {
    await expect(
      listInstalledWorkspaceAgents(folderRuntime(null, 1), {
        worktreeId: 'folder:hub'
      })
    ).rejects.toMatchObject({ code: 'selector_ambiguous' })
  })

  it('retains the selected local folder project WSL preference', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      const runtime = folderRuntime(null, 1)
      const selected = runtime.resolveManagedFolderWorkspace('folder:hub', 'local')
      const host = await resolveQualifiedAgentDetectionHost(
        runtime,
        {
          worktreeId: 'folder:hub',
          worktreeHostId: 'local'
        },
        undefined,
        selected ?? undefined
      )

      expect(host).toMatchObject({
        kind: 'local',
        context: {
          projectRuntime: {
            status: 'resolved',
            runtime: { kind: 'wsl', distro: 'Ubuntu' }
          }
        }
      })
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })
})
