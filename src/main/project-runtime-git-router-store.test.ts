/**
 * The router against the real Store: a runtime switch or a new worktree is routed on the very next
 * Git call, because the Store's write drops the table synchronously.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WSL_HOSTS_INTERNAL_GATE_ENV } from '../shared/wsl-host-internal-gate'
import { hostWorktreeTarget } from '../shared/worktree/host-qualified-identity'
import {
  isLocalGitRuntimeRouterInstalled,
  routeLocalGitOptions,
  setLocalGitRuntimeRouter
} from './git/command-runner/local-git-runtime-route'
import { fixture } from './persistence/loading-store/profile-state-delayed-authority-fixture'
import { installProjectRuntimeGitRouter } from './project-runtime-git-router'

vi.mock('./telemetry/client', () => ({ track: vi.fn() }))
vi.mock('./telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('./ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const originalPlatform = process.platform
const REPO = String.raw`C:\src\app`

beforeEach(() => {
  vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
})

afterEach(() => {
  setLocalGitRuntimeRouter(null)
  vi.unstubAllEnvs()
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
})

const distroFor = (cwd: string): string | undefined =>
  routeLocalGitOptions<{ cwd: string; wslDistro?: string }>({ cwd }).wslDistro

describe('project runtime Git routing on the real Store', () => {
  it.each([
    ['the WSL hosts gate is closed', '', 'win32'],
    ['not on Windows', '1', 'linux']
  ])('installs no router, and drops one, when %s', async (_case, gate, platform) => {
    const { store } = await fixture()
    const onStateWritten = vi.spyOn(store, 'onStateWritten')
    vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, gate)
    Object.defineProperty(process, 'platform', { configurable: true, value: platform })
    setLocalGitRuntimeRouter(() => 'Ubuntu')
    installProjectRuntimeGitRouter(store)
    expect(isLocalGitRuntimeRouterInstalled()).toBe(false)
    expect(onStateWritten).not.toHaveBeenCalled()
    expect(distroFor(REPO)).toBeUndefined()
  })

  it('never runs a Git call on a stale route after a runtime switch or a new worktree', async () => {
    const { store } = await fixture()
    store.updateSettings({ localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' } })
    store.addRepo({
      id: 'app',
      path: REPO,
      displayName: 'app',
      badgeColor: '',
      addedAt: 0,
      kind: 'git'
    })
    installProjectRuntimeGitRouter(store)
    expect(distroFor(REPO)).toBe('Ubuntu')

    const project = store.getProjects().find((entry) => entry.sourceRepoIds.includes('app'))
    store.updateProject(project!.id, {
      localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu', git: 'windows-host' }
    })
    expect(distroFor(REPO)).toBeUndefined()

    store.updateProject(project!.id, {
      localWindowsRuntimePreference: { kind: 'wsl', distro: 'Debian' }
    })
    expect(distroFor(REPO)).toBe('Debian')

    const worktree = String.raw`D:\trees\app-fix`
    expect(distroFor(worktree)).toBeUndefined()
    store.setWorktreeMeta(hostWorktreeTarget({ id: `app::${worktree}`, hostId: 'local' }), {
      isPinned: true
    })
    expect(distroFor(`${worktree}\\src`)).toBe('Debian')
  })
})
