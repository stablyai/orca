import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { wslDistroForCommand } from '../../../../shared/file-access/wsl-paths'
import { PROJECT_RUNTIME_REPAIR_REQUIRED_CODE } from '../../../../shared/execution-host/project-runtime-repair-message'
import { makeFolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-host-routing.test-fixture'
import type { Repo } from '../../../../shared/repository/repo-types'
import type { Project } from '../../../../shared/project/project-types'
import { getLocalProjectWorktreeGitOptions } from '../../../workspaces/execution-host/project-runtime-git-options'
import {
  _resetWslCachesForTests,
  _setWslCachesForTests
} from '../../../wsl/discovery/distro-catalog'
import { agentLaunchProjectRuntime } from '../../terminal/launch/agent-launch-scope-runtime'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { resolveLocalPtyOptions } from '../../../workspaces/execution-host/local-project-runtime-pty-options'
import { modelDiscoveryWslDistro } from './model-discovery-workspace-runtime'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
const repoPath = String.raw`C:\src\app`

const repo: Repo = {
  id: 'app',
  path: repoPath,
  displayName: 'app',
  badgeColor: '',
  addedAt: 0
}

const project: Project = {
  id: 'project',
  displayName: 'app',
  badgeColor: '',
  sourceRepoIds: ['app'],
  createdAt: 0,
  updatedAt: 0,
  localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu', git: 'windows-host' }
}

const store = {
  getProjects: () => [project],
  getSettings: () => ({})
}

describe('modelDiscoveryWslDistro', () => {
  beforeEach(() => {
    _resetWslCachesForTests()
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  })

  afterEach(() => {
    _resetWslCachesForTests()
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  it('uses the WSL agent runtime when Git stays on the Windows host', () => {
    expect(getLocalProjectWorktreeGitOptions(store, repo)).toEqual({})
    expect(
      modelDiscoveryWslDistro(store, {
        id: 'app::worktree',
        path: repoPath,
        connectionId: null,
        repo,
        folderWorkspace: null
      })
    ).toBe('Ubuntu')
  })

  it('uses the PowerShell terminal for a repo-less folder when launch does', () => {
    const path = String.raw`C:\notes`
    const folder = makeFolderWorkspace({ id: 'notes', folderPath: path, connectionId: null })
    const store = {
      getProjects: () => [],
      getRepos: () => [],
      getProjectGroups: () => [],
      getFolderWorkspaces: () => [folder],
      getSettings: () => ({
        localWindowsRuntimeDefault: { kind: 'wsl' as const, distro: 'Ubuntu' },
        terminalWindowsShell: 'powershell.exe'
      })
    }
    const scope = {
      id: 'folder:notes',
      path,
      connectionId: null,
      repo: null,
      folderWorkspace: folder
    }
    const launched = resolveLocalPtyOptions(
      store.getSettings(),
      agentLaunchProjectRuntime(store, scope, 'claude'),
      undefined,
      process.env.COMSPEC || 'powershell.exe'
    )
    expect(launched).toEqual({ shellOverride: 'powershell.exe', terminalWindowsWslDistro: null })
    expect(modelDiscoveryWslDistro(store, scope)).toBeUndefined()
  })

  it('does not dispatch to a project WSL distro that is not installed', () => {
    _setWslCachesForTests({ available: true, distros: ['Debian'] })
    const missingRepo: Repo = { ...repo, id: 'missing' }
    const missingProject: Project = {
      ...project,
      id: 'missing',
      sourceRepoIds: ['missing'],
      localWindowsRuntimePreference: { kind: 'wsl', distro: 'Gone', git: 'windows-host' }
    }
    const missingStore = {
      getProjects: () => [missingProject],
      getSettings: () => ({})
    }
    const scope = {
      id: 'missing::worktree',
      path: repoPath,
      connectionId: null,
      repo: missingRepo,
      folderWorkspace: null
    }
    expect(agentLaunchProjectRuntime(missingStore, scope, 'claude')?.status).toBe('repair-required')
    try {
      modelDiscoveryWslDistro(missingStore, scope)
      throw new Error('model discovery dispatched')
    } catch (error) {
      expect(error).toBeInstanceOf(OrchestrationError)
      if (error instanceof OrchestrationError) {
        expect(error.code).toBe(PROJECT_RUNTIME_REPAIR_REQUIRED_CODE)
      }
    }
  })

  it('uses the UNC distro the command enters when the project prefers another distro', () => {
    const path = String.raw`\\wsl.localhost\Debian\home\dev\repo`
    expect(
      modelDiscoveryWslDistro(store, {
        id: 'app::worktree',
        path,
        connectionId: null,
        repo,
        folderWorkspace: null
      })
    ).toBe('Debian')
    expect(wslDistroForCommand(path, 'Ubuntu')).toBe('Debian')
  })
})
