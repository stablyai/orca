import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import type { TerminalWorkspaceLaunchScope } from './runtime-legacy-worker-terminal-recovery-types'
import type { Repo } from '../../shared/repo-types'
import type { LocalWindowsRuntimePreference } from '../../shared/project-execution-runtime'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp'), isPackaged: false }
}))

const WSL_PATH = String.raw`\\wsl$\Ubuntu\home\alice\repo`
const HOST_PATH = String.raw`C:\Users\alice\repo`
const hostPlatform = process.platform

class LaunchPlatformProbe extends OrcaRuntimeService {
  platformFor(scope: TerminalWorkspaceLaunchScope): NodeJS.Platform {
    return this.getAgentLaunchPlatformForWorkspace(scope)
  }
}

function makeRepo(path: string, connectionId: string | null = null): Repo {
  return { id: 'repo-1', path, connectionId, displayName: 'repo', badgeColor: 'blue', addedAt: 1 }
}

function makeProbe(projectPreference?: LocalWindowsRuntimePreference): LaunchPlatformProbe {
  const store = {
    getProjects: () => [
      {
        id: 'project-1',
        sourceRepoIds: ['repo-1'],
        ...(projectPreference ? { localWindowsRuntimePreference: projectPreference } : {})
      }
    ],
    getRepo: () => undefined,
    getSettings: () => ({})
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: launch-platform resolution reads only getProjects, getRepo and getSettings.
  return new LaunchPlatformProbe(store as never)
}

function scopeFor(
  workspace: 'repo' | 'folder',
  path: string,
  connectionId: string | null = null
): TerminalWorkspaceLaunchScope {
  return {
    id: workspace === 'repo' ? 'repo-1::worktree' : 'fw-1',
    path,
    connectionId,
    repo: workspace === 'repo' ? makeRepo(path, connectionId) : null,
    folderWorkspace: null
  }
}

function setHostPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
}

// Pins main's current launch behaviour as the convergence parity baseline (rules HOST_REPO and
// HOST_FOLDER_PATH; serve the host planner, rows 3, 4 and 10): the platform the host quotes for.
describe('HOST_REPO / HOST_FOLDER_PATH: getAgentLaunchPlatformForWorkspace on main', () => {
  afterEach(() => {
    setHostPlatform(hostPlatform)
  })

  it.each([
    // host, workspace, path, quoting platform
    // HOST_REPO: a repo reads its project preference and the global default, never its path.
    ['win32', 'repo', WSL_PATH, 'win32'],
    ['win32', 'repo', HOST_PATH, 'win32'],
    // HOST_FOLDER_PATH: a folder reads only its path.
    ['win32', 'folder', WSL_PATH, 'linux'],
    ['win32', 'folder', HOST_PATH, 'win32'],
    ['darwin', 'repo', WSL_PATH, 'darwin'],
    ['darwin', 'repo', HOST_PATH, 'darwin'],
    ['darwin', 'folder', WSL_PATH, 'linux'],
    ['darwin', 'folder', HOST_PATH, 'darwin']
  ] as const)(
    '%s host, local %s at %s with no project preference quotes for %s',
    (host, workspace, path, platform) => {
      setHostPlatform(host)
      expect(makeProbe().platformFor(scopeFor(workspace, path))).toBe(platform)
    }
  )

  it.each([
    // host, project preference, quoting platform for a repo at C:\
    ['win32', { kind: 'wsl', distro: 'Ubuntu' }, 'linux'],
    ['win32', { kind: 'windows-host' }, 'win32'],
    ['darwin', { kind: 'wsl', distro: 'Ubuntu' }, 'darwin']
  ] as const)('%s host, repo with project preference %j quotes for %s', (host, pref, platform) => {
    setHostPlatform(host)
    expect(makeProbe(pref).platformFor(scopeFor('repo', HOST_PATH))).toBe(platform)
  })

  it.each([
    // workspace, remote path, quoting platform (same on every host)
    ['repo', '/home/alice/repo', 'linux'],
    ['repo', HOST_PATH, 'win32'],
    ['folder', '/home/alice/repo', 'linux'],
    ['folder', HOST_PATH, 'win32']
  ] as const)('SSH %s at %s quotes for %s', (workspace, path, platform) => {
    for (const host of ['win32', 'darwin'] as const) {
      setHostPlatform(host)
      expect(makeProbe().platformFor(scopeFor(workspace, path, 'ssh-1'))).toBe(platform)
    }
  })
})
