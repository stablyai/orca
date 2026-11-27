import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { _resetPreflightCache, runPreflightCheck } from './agent-detection'
import { assertWslDistroRunningForExec } from '../wsl/discovery/wsl-background-exec-gate'
import { WslDistroStoppedError } from '../wsl/filesystem/wsl-unc-access-gate'
import { isCommandAvailable } from '../ipc/preflight/preflight-command-exec'

// Native Windows has git and gh but no glab; only the default distro "Ubuntu" has glab.
vi.mock('../ipc/preflight/preflight-command-exec', () => ({
  findRunnableLocalCommand: vi.fn(async (command: string) =>
    command === 'glab' ? { status: 'absent' } : { status: 'available', binary: command }
  ),
  isCommandAvailable: vi.fn(
    async (command: string, target?: { distro?: string }) =>
      command === 'glab' && target?.distro === 'Ubuntu'
  ),
  execCommandInWslOrThrow: vi.fn(async () => ({ stdout: 'Logged in', stderr: '' })),
  execLocalPreflightCommandOrThrow: vi.fn(async () => ({ stdout: 'Logged in', stderr: '' }))
}))
vi.mock('../git/command-runner/host-routing/wsl-command-resolution', () => ({
  defaultWslCliDistroAsync: async () => 'Ubuntu'
}))
vi.mock('../wsl/discovery/wsl-background-exec-gate', () => ({
  assertWslDistroRunningForExec: vi.fn(async () => undefined)
}))
vi.mock('../pty/environment/windows-environment-path', () => ({
  mergePersistedWindowsPathAsync: vi.fn(async () => undefined)
}))
vi.mock('../bitbucket/client', () => ({ getBitbucketAuthStatus: vi.fn(async () => undefined) }))
vi.mock('../azure-devops/client', () => ({
  getAzureDevOpsAuthStatus: vi.fn(async () => undefined)
}))
vi.mock('../gitea/client', () => ({ getGiteaAuthStatus: vi.fn(async () => undefined) }))

const nativeWorkspace = {
  projectRuntime: {
    status: 'resolved',
    runtime: {
      kind: 'windows-host',
      hostPlatform: 'win32',
      projectId: 'p',
      reason: 'project-override',
      cacheKey: 'p'
    }
  }
} as const

const platform = process.platform
beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  _resetPreflightCache()
})
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform })
})

it('reports glab from the default distro when no workspace names a runtime, as cwd-less glab calls use it', async () => {
  // A stopped default distro is never booted for a background read, and nothing stale is kept.
  vi.mocked(assertWslDistroRunningForExec).mockRejectedValueOnce(
    new WslDistroStoppedError('Ubuntu')
  )
  await expect(runPreflightCheck()).resolves.toMatchObject({ glab: { installed: false } })
  expect(isCommandAvailable).not.toHaveBeenCalledWith('glab', { distro: 'Ubuntu' })

  await expect(runPreflightCheck()).resolves.toMatchObject({
    glab: { installed: true, authenticated: true }
  })
  // A focused native-Windows workspace runs glab natively, so its answer stays native.
  await expect(runPreflightCheck(false, nativeWorkspace)).resolves.toMatchObject({
    glab: { installed: false }
  })
})
