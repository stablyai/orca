import '../runtime/rpc/unused-default-rpc-methods.test-fixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../runtime/rpc/dispatcher'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { PREFLIGHT_METHODS } from '../runtime/rpc/methods/preflight'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { GlobalWindowsRuntimeDefault } from '../../shared/project-execution-runtime'
import type { Project } from '../../shared/project-types'
import type { ProjectGroup } from '../../shared/project-group-types'
import type { Repo } from '../../shared/repo-types'
import { folderWorkspaceKey, parseWorkspaceKey } from '../../shared/workspace-scope'
import { splitWorktreeId } from '../../shared/worktree/id'
import {
  resolveWorkspaceAgentDetectionHost,
  type WorkspaceAgentDetectionStore
} from './workspace-agent-detection'

const { detectInstalledMock, detectRemoteMock, refreshMock } = vi.hoisted(() => ({
  detectInstalledMock: vi.fn(),
  detectRemoteMock: vi.fn(),
  refreshMock: vi.fn()
}))

vi.mock('./agent-detection', () => ({
  detectInstalledAgentsWithShellPathHydration: detectInstalledMock,
  detectRemoteAgents: detectRemoteMock,
  refreshShellPathAndDetectAgents: refreshMock,
  detectRemoteWindowsTerminalCapabilities: vi.fn(),
  runPreflightCheck: vi.fn()
}))

const WSL_REPO_PATH = '\\\\wsl.localhost\\Ubuntu-24.04\\home\\me\\project\\repo'
const originalPlatform = process.platform

function repo(overrides: Partial<Repo> & Pick<Repo, 'id' | 'path'>): Repo {
  return { displayName: overrides.id, badgeColor: 'blue', addedAt: 1, ...overrides }
}

function project(
  id: string,
  repoIds: string[],
  preference?: Project['localWindowsRuntimePreference']
): Project {
  return {
    id,
    displayName: id,
    badgeColor: 'blue',
    sourceRepoIds: repoIds,
    createdAt: 1,
    updatedAt: 1,
    ...(preference ? { localWindowsRuntimePreference: preference } : {})
  }
}

const GROUP: ProjectGroup = {
  id: 'g1',
  name: 'g1',
  parentPath: null,
  connectionId: null,
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 1,
  updatedAt: 1
}

const FOLDER: FolderWorkspace = {
  id: 'f1',
  projectGroupId: 'g1',
  name: 'f1',
  folderPath: WSL_REPO_PATH,
  linkedTask: null,
  comment: '',
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 1,
  createdAt: 1,
  updatedAt: 1
}

function store(args: {
  repos: Repo[]
  projects?: Project[]
  globalDefault?: GlobalWindowsRuntimeDefault
  folderWorkspaces?: FolderWorkspace[]
  projectGroups?: ProjectGroup[]
}): WorkspaceAgentDetectionStore {
  return {
    getRepos: () => args.repos,
    getRepo: (id: string) => args.repos.find((entry) => entry.id === id),
    getProjects: () => args.projects ?? [],
    getSettings: () => ({ localWindowsRuntimeDefault: args.globalDefault }),
    getFolderWorkspaces: () => args.folderWorkspaces ?? [],
    getProjectGroups: () => args.projectGroups ?? []
  }
}

function wslContext(distro: string, projectId: string, reason: string) {
  return {
    projectRuntime: {
      status: 'resolved',
      runtime: expect.objectContaining({ kind: 'wsl', distro, projectId, reason })
    }
  }
}

// Stands in for the runtime, which reads the worktree's host and path from its own list.
function resolveFor(s: WorkspaceAgentDetectionStore, workspaceId: string, hostId?: string) {
  const scope = parseWorkspaceKey(workspaceId)
  if (scope?.type === 'folder') {
    return resolveWorkspaceAgentDetectionHost(s, {
      kind: 'folder',
      folderWorkspaceId: scope.folderWorkspaceId
    })
  }
  const parsed = splitWorktreeId(workspaceId)
  if (!parsed) {
    throw new Error(`not a worktree id: ${workspaceId}`)
  }
  return resolveWorkspaceAgentDetectionHost(s, {
    kind: 'worktree',
    repoId: parsed.repoId,
    path: parsed.worktreePath,
    hostId
  })
}

describe('resolveWorkspaceAgentDetectionHost on a Windows host', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
  })
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
  })

  it('keeps the host default for a workspace no repo row owns', () => {
    const s = store({ repos: [repo({ id: 'r1', path: 'C:\\r1' })] })
    expect(resolveFor(s, 'missing::C:\\x')).toEqual({ kind: 'local' })
  })

  it('routes by the worktree owner, not the first row sharing its repo id', () => {
    const sshRow = repo({ id: 'r1', path: '/srv/r1', executionHostId: 'ssh:build-host' })
    const localRow = repo({ id: 'r1', path: 'C:\\src\\r1', executionHostId: 'local' })
    for (const repos of [
      [sshRow, localRow],
      [localRow, sshRow]
    ]) {
      const s = store({ repos })
      expect(resolveFor(s, 'r1::C:\\src\\r1', 'local')).toEqual({
        kind: 'local',
        context: {
          projectRuntime: {
            status: 'resolved',
            runtime: expect.objectContaining({ kind: 'windows-host' })
          }
        }
      })
      expect(resolveFor(s, 'r1::/srv/r1', 'ssh:build-host')).toEqual({
        kind: 'ssh',
        connectionId: 'build-host'
      })
      // Rival rows and no worktree host name no single owner: refuse rather than guess.
      expect(() => resolveFor(s, 'r1::/srv/r1')).toThrow('worktree_execution_host_unresolved')
    }
  })

  it('probes inside the distro of a WSL-share workspace with no saved runtime', () => {
    const s = store({ repos: [repo({ id: 'r1', path: WSL_REPO_PATH })] })
    expect(resolveFor(s, `r1::${WSL_REPO_PATH}`)).toEqual({
      kind: 'local',
      context: wslContext('Ubuntu-24.04', 'r1', 'project-override')
    })
  })

  it('follows the global WSL default for a project that inherits it', () => {
    const s = store({
      repos: [repo({ id: 'r1', path: 'C:\\src\\r1' })],
      projects: [project('p1', ['r1'])],
      globalDefault: { kind: 'wsl', distro: 'Ubuntu' }
    })
    expect(resolveFor(s, 'r1::C:\\src\\r1')).toEqual({
      kind: 'local',
      context: wslContext('Ubuntu', 'p1', 'global-default')
    })
  })

  it("lets the project's own runtime win over a WSL-share path", () => {
    const s = store({
      repos: [repo({ id: 'r1', path: WSL_REPO_PATH })],
      projects: [project('p1', ['r1'], { kind: 'windows-host' })]
    })
    expect(resolveFor(s, `r1::${WSL_REPO_PATH}`)).toEqual({
      kind: 'local',
      context: {
        projectRuntime: {
          status: 'resolved',
          runtime: expect.objectContaining({ kind: 'windows-host', reason: 'project-override' })
        }
      }
    })
  })

  it('routes an SSH workspace to its target, under either ownership spelling', () => {
    const s = store({
      repos: [
        repo({ id: 'legacy', path: '/srv/a', connectionId: 'ssh-a' }),
        repo({ id: 'unified', path: '/srv/b', executionHostId: 'ssh:ssh-b' })
      ]
    })
    expect(resolveFor(s, 'legacy::/srv/a')).toEqual({
      kind: 'ssh',
      connectionId: 'ssh-a'
    })
    expect(resolveFor(s, 'unified::/srv/b')).toEqual({
      kind: 'ssh',
      connectionId: 'ssh-b'
    })
  })

  it('resolves a local folder workspace through its only repo', () => {
    const s = store({
      repos: [repo({ id: 'r1', path: WSL_REPO_PATH, projectGroupId: 'g1' })],
      projectGroups: [GROUP],
      folderWorkspaces: [FOLDER]
    })
    expect(resolveFor(s, folderWorkspaceKey('f1'))).toEqual({
      kind: 'local',
      context: wslContext('Ubuntu-24.04', 'r1', 'project-override')
    })
  })
  it('refuses a folder whose candidate repos live on different SSH hosts', () => {
    const s = store({
      repos: [
        repo({ id: 'a', path: '/srv/a', executionHostId: 'ssh:one', projectGroupId: 'g1' }),
        repo({ id: 'b', path: '/srv/b', executionHostId: 'ssh:two', projectGroupId: 'g1' })
      ],
      projectGroups: [GROUP],
      folderWorkspaces: [{ ...FOLDER, folderPath: '/srv' }]
    })
    expect(() => resolveFor(s, folderWorkspaceKey('f1'))).toThrow(
      'worktree_execution_host_unresolved'
    )
  })
})

describe('preflight.detectAgents resolves the workspace on the host', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    detectInstalledMock.mockReset().mockResolvedValue(['claude', 'codex'])
  })
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
  })

  function dispatcherFor(s: WorkspaceAgentDetectionStore) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these methods read only resolveAgentDetectionHost and getRuntimeId from the runtime.
    const runtime = {
      getRuntimeId: () => 'host',
      resolveAgentDetectionHost: async (worktreeId?: string) =>
        worktreeId ? resolveFor(s, worktreeId) : { kind: 'local' }
    } as unknown as OrcaRuntimeService
    return new RpcDispatcher({ runtime, methods: PREFLIGHT_METHODS })
  }

  it('#19885: a paired client naming a WSL-hosted workspace gets the distro probe', async () => {
    const dispatcher = dispatcherFor(store({ repos: [repo({ id: 'r1', path: WSL_REPO_PATH })] }))
    const response = await dispatcher.dispatch({
      id: '1',
      authToken: 't',
      method: 'preflight.detectAgents',
      params: { worktreeId: `r1::${WSL_REPO_PATH}` }
    })
    expect(detectInstalledMock).toHaveBeenCalledWith(
      wslContext('Ubuntu-24.04', 'r1', 'project-override')
    )
    expect(response).toMatchObject({ ok: true, result: ['claude', 'codex'] })
  })

  it('#18666: a project on the global WSL default is probed in that distro', async () => {
    const dispatcher = dispatcherFor(
      store({
        repos: [repo({ id: 'r1', path: 'C:\\src\\r1' })],
        projects: [project('p1', ['r1'])],
        globalDefault: { kind: 'wsl', distro: 'Ubuntu' }
      })
    )
    await dispatcher.dispatch({
      id: '1',
      authToken: 't',
      method: 'preflight.refreshAgents',
      params: { worktreeId: 'r1::C:\\src\\r1' }
    })
    expect(refreshMock).toHaveBeenCalledWith(wslContext('Ubuntu', 'p1', 'global-default'))
  })
})
