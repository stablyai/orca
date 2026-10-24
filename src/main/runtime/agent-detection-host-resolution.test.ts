import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electronMocks = vi.hoisted(() => {
  const ipcMain = {
    on: vi.fn(() => ipcMain),
    removeListener: vi.fn(() => ipcMain),
    emit: vi.fn(() => true)
  }
  return {
    BrowserWindow: { fromId: vi.fn((): unknown => null) },
    webContents: { fromId: vi.fn((): unknown => null) },
    ipcMain,
    app: { getPath: vi.fn(() => '/tmp'), isPackaged: false }
  }
})
vi.mock('electron', () => electronMocks)

import { OrcaRuntimeService } from './orca-runtime'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'
import type { Repo } from '../../shared/repo-types'
import type { Project } from '../../shared/project-types'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'

const originalPlatform = process.platform

function makeRuntime(repos: Repo[], projects: Project[] = []) {
  const store = {
    getRepo: (id: string) => repos.find((repo) => repo.id === id),
    getRepos: () => repos,
    getProjects: () => projects,
    getSettings: () => ({ localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' } })
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: detection resolution reads only the repo, project and settings members supplied here.
  const runtime = new OrcaRuntimeService(store as never)
  const selector = vi.fn<(selector: string) => Promise<ResolvedWorktree>>()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: replaces the protected worktree lookup this method awaits; its signature is restated above.
  ;(runtime as unknown as { resolveWorktreeSelector: typeof selector }).resolveWorktreeSelector =
    selector
  return { runtime, selector }
}

function worktree(fields: Partial<ResolvedWorktree>): ResolvedWorktree {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the method reads only repoId, path and hostId.
  return fields as ResolvedWorktree
}

describe('OrcaRuntimeService.resolveAgentDetectionHost', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
  })
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
  })

  const local: Repo = {
    id: 'r1',
    path: 'C:\\src\\r1',
    displayName: 'r1',
    badgeColor: 'blue',
    addedAt: 1,
    executionHostId: 'local'
  }

  it('keeps the host default for no, floating, or unknown workspaces', async () => {
    const { runtime, selector } = makeRuntime([local])
    selector.mockRejectedValue(new Error('selector_not_found'))
    expect(await runtime.resolveAgentDetectionHost(undefined)).toEqual({ kind: 'local' })
    expect(await runtime.resolveAgentDetectionHost(FLOATING_TERMINAL_WORKTREE_ID)).toEqual({
      kind: 'local'
    })
    expect(await runtime.resolveAgentDetectionHost('r1::C:\\gone')).toEqual({ kind: 'local' })
    expect(selector).toHaveBeenCalledTimes(1)
  })

  it('refuses a workspace id two hosts share instead of probing this one', async () => {
    const { runtime, selector } = makeRuntime([local])
    selector.mockRejectedValue(new Error('selector_ambiguous'))
    await expect(runtime.resolveAgentDetectionHost('r1::/srv/r1')).rejects.toThrow(
      'selector_ambiguous'
    )
  })

  it('resolves the selected repo before a workspace exists (#20060)', async () => {
    const wslRepo: Repo = { ...local, path: '\\\\wsl.localhost\\Debian\\home\\neil\\repo' }
    const { runtime, selector } = makeRuntime([wslRepo])
    expect(await runtime.resolveAgentDetectionHost(undefined, local.id)).toEqual({
      kind: 'local',
      context: {
        projectRuntime: {
          status: 'resolved',
          runtime: expect.objectContaining({ kind: 'wsl', distro: 'Debian' })
        }
      }
    })
    expect(selector).not.toHaveBeenCalled()
  })

  it('refuses a repository target without a store while retaining the untargeted default', async () => {
    const runtime = new OrcaRuntimeService(null)
    await expect(runtime.resolveAgentDetectionHost(undefined, local.id)).rejects.toThrow(
      'repo_not_found'
    )
    expect(await runtime.resolveAgentDetectionHost(undefined)).toEqual({ kind: 'local' })
    expect(
      await runtime.resolveAgentDetectionHost(FLOATING_TERMINAL_WORKTREE_ID, local.id)
    ).toEqual({
      kind: 'local'
    })
  })

  it.each(['removed', 'path', 'owner', 'connection', 'duplicate'] as const)(
    'refuses a selected repository %s change across the selector await',
    async (change) => {
      const selected = { ...local, path: '\\\\wsl$\\Old\\home\\repo' }
      const repos: Repo[] = [selected]
      const { runtime } = makeRuntime(repos)
      const pending = runtime.resolveAgentDetectionHost(undefined, local.id)
      repos.splice(
        0,
        1,
        ...(change === 'removed'
          ? []
          : change === 'duplicate'
            ? [selected, { ...selected }]
            : [
                {
                  ...selected,
                  ...(change === 'path' ? { path: '\\\\wsl$\\Current\\home\\repo' } : {}),
                  ...(change === 'owner' ? { executionHostId: 'ssh:build-host' as const } : {}),
                  ...(change === 'connection' ? { connectionId: 'build-host' } : {})
                }
              ])
      )
      await expect(pending).rejects.toThrow('repo_target_changed')
    }
  )

  it('keeps repo detection on its configured runtime for a Windows path', async () => {
    const { runtime } = makeRuntime([local])
    expect(await runtime.resolveAgentDetectionHost(undefined, local.id)).toMatchObject({
      kind: 'local',
      context: { projectRuntime: { runtime: { kind: 'wsl', distro: 'Ubuntu' } } }
    })
  })

  it.each(['darwin', 'linux', 'win32'])(
    'matches existing workspace runtime resolution on %s',
    async (platform) => {
      Object.defineProperty(process, 'platform', { value: platform })
      const selected = { ...local, path: platform === 'win32' ? local.path : '/src/r1' }
      const { runtime, selector } = makeRuntime([selected])
      selector.mockResolvedValue(
        worktree({ repoId: selected.id, path: selected.path, hostId: 'local' })
      )
      const detected = await runtime.resolveAgentDetectionHost(undefined, selected.id)
      expect(detected).toEqual(
        await runtime.resolveAgentDetectionHost(`${selected.id}::${selected.path}`)
      )
      expect(detected).toMatchObject({
        kind: 'local',
        context: {
          projectRuntime: { runtime: { kind: platform === 'win32' ? 'wsl' : 'local-host' } }
        }
      })
    }
  )

  it('keeps project overrides above a selected folder repo WSL path', async () => {
    const folderRepo: Repo = {
      ...local,
      kind: 'folder',
      path: '\\\\wsl$\\Debian\\home\\neil\\notes'
    }
    const project: Project = {
      id: 'project-1',
      displayName: 'Notes',
      badgeColor: 'blue',
      sourceRepoIds: [local.id],
      localWindowsRuntimePreference: { kind: 'windows-host' },
      createdAt: 1,
      updatedAt: 1
    }
    const { runtime } = makeRuntime([folderRepo], [project])
    expect(await runtime.resolveAgentDetectionHost(undefined, local.id)).toMatchObject({
      kind: 'local',
      context: { projectRuntime: { runtime: { kind: 'windows-host', reason: 'project-override' } } }
    })
  })

  it.each([{ connectionId: 'build-host' }, { executionHostId: 'ssh:build-host' }] as const)(
    'preserves selected repo SSH ownership: %j',
    async (ownership) => {
      const { runtime } = makeRuntime([
        { ...local, executionHostId: undefined, ...ownership, path: '/srv/r1' }
      ])
      expect(await runtime.resolveAgentDetectionHost(undefined, local.id)).toEqual({
        kind: 'ssh',
        connectionId: 'build-host'
      })
    }
  )

  it('keeps an explicit workspace authoritative when a repo target is also sent', async () => {
    const { runtime, selector } = makeRuntime([local])
    selector.mockResolvedValue(worktree({ repoId: local.id, path: local.path, hostId: 'local' }))
    const workspaceId = `${local.id}::${local.path}`
    expect(await runtime.resolveAgentDetectionHost(workspaceId, 'missing')).toEqual(
      await runtime.resolveAgentDetectionHost(workspaceId)
    )
    expect(
      await runtime.resolveAgentDetectionHost(FLOATING_TERMINAL_WORKTREE_ID, 'missing')
    ).toEqual({ kind: 'local' })
  })

  it('refuses an unknown or ambiguous repo instead of probing the host default', async () => {
    const { runtime } = makeRuntime([local, { ...local, executionHostId: 'runtime:other' }])
    await expect(runtime.resolveAgentDetectionHost(undefined, local.id)).rejects.toThrow(
      'selector_ambiguous'
    )
    await expect(runtime.resolveAgentDetectionHost(undefined, 'missing')).rejects.toThrow(
      'repo_not_found'
    )
  })

  it.each(['runtime:%broken', 'ssh:%broken'] as const)(
    'refuses a selected repository with malformed owner %s',
    async (executionHostId) => {
      const { runtime } = makeRuntime([{ ...local, executionHostId }])
      await expect(runtime.resolveAgentDetectionHost(undefined, local.id)).rejects.toThrow(
        'worktree_execution_host_unresolved'
      )
    }
  )

  it('refuses a repo owned by another runtime', async () => {
    const { runtime } = makeRuntime([{ ...local, executionHostId: 'runtime:other' }])
    await expect(runtime.resolveAgentDetectionHost(undefined, local.id)).rejects.toThrow(
      'workspace_on_other_runtime'
    )
  })

  it("routes by the host's own worktree record", async () => {
    const ssh: Repo = { ...local, path: '/srv/r1', executionHostId: 'ssh:build-host' }
    const { runtime, selector } = makeRuntime([ssh, local])
    selector.mockResolvedValueOnce(worktree({ repoId: 'r1', path: 'C:\\src\\r1', hostId: 'local' }))
    expect(await runtime.resolveAgentDetectionHost('r1::C:\\src\\r1')).toEqual({
      kind: 'local',
      context: {
        projectRuntime: {
          status: 'resolved',
          runtime: expect.objectContaining({ kind: 'wsl', distro: 'Ubuntu' })
        }
      }
    })
    expect(selector).toHaveBeenCalledWith('id:r1::C:\\src\\r1')
  })
})
