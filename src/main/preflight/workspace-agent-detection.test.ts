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
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'
import { folderWorkspaceKey } from '../../shared/workspace-scope'
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

describe('resolveWorkspaceAgentDetectionHost on a Windows host', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
  })
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
  })

  it('keeps the host default when no workspace is named, unknown, or floating', () => {
    const s = store({ repos: [repo({ id: 'r1', path: 'C:\\r1' })] })
    expect(resolveWorkspaceAgentDetectionHost(s, undefined)).toEqual({ kind: 'local' })
    expect(resolveWorkspaceAgentDetectionHost(s, 'missing::C:\\x')).toEqual({ kind: 'local' })
    expect(resolveWorkspaceAgentDetectionHost(s, FLOATING_TERMINAL_WORKTREE_ID)).toEqual({
      kind: 'local'
    })
  })

  it('probes inside the distro of a WSL-share workspace with no saved runtime', () => {
    const s = store({ repos: [repo({ id: 'r1', path: WSL_REPO_PATH })] })
    expect(resolveWorkspaceAgentDetectionHost(s, `r1::${WSL_REPO_PATH}`)).toEqual({
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
    expect(resolveWorkspaceAgentDetectionHost(s, 'r1::C:\\src\\r1')).toEqual({
      kind: 'local',
      context: wslContext('Ubuntu', 'p1', 'global-default')
    })
  })

  it("lets the project's own runtime win over a WSL-share path", () => {
    const s = store({
      repos: [repo({ id: 'r1', path: WSL_REPO_PATH })],
      projects: [project('p1', ['r1'], { kind: 'windows-host' })]
    })
    expect(resolveWorkspaceAgentDetectionHost(s, `r1::${WSL_REPO_PATH}`)).toEqual({
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
    expect(resolveWorkspaceAgentDetectionHost(s, 'legacy::/srv/a')).toEqual({
      kind: 'ssh',
      connectionId: 'ssh-a'
    })
    expect(resolveWorkspaceAgentDetectionHost(s, 'unified::/srv/b')).toEqual({
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
    expect(resolveWorkspaceAgentDetectionHost(s, folderWorkspaceKey('f1'))).toEqual({
      kind: 'local',
      context: wslContext('Ubuntu-24.04', 'r1', 'project-override')
    })
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
      resolveAgentDetectionHost: (worktreeId?: string) =>
        resolveWorkspaceAgentDetectionHost(s, worktreeId)
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
