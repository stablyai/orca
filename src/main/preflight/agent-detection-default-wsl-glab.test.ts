import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { _resetPreflightCache, runPreflightCheck } from './agent-detection'
import { blockedWslDistroForExec } from '../wsl/discovery/wsl-background-exec-gate'
import { findRunnableLocalCommand } from '../ipc/preflight/preflight-command-exec'
import { deferUntilWslDistroRunning } from '../wsl/discovery/wsl-background-distro-gate'

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
  defaultWslCliDistro: () => 'Ubuntu',
  defaultWslCliDistroAsync: async () => 'Ubuntu',
  resolveCommand: vi.fn()
}))
vi.mock('../wsl/discovery/wsl-background-exec-gate', () => ({
  blockedWslDistroForExec: vi.fn(async () => null),
  assertWslDistroRunningForExec: vi.fn(async () => undefined)
}))
vi.mock('../wsl/discovery/wsl-background-distro-gate', () => ({
  deferUntilWslDistroRunning: vi.fn(() => () => {})
}))
vi.mock('../pty/environment/windows-environment-path', () => ({
  mergePersistedWindowsPathAsync: vi.fn(async () => undefined)
}))
vi.mock('../bitbucket/client', () => ({ getBitbucketAuthStatus: vi.fn(async () => undefined) }))
vi.mock('../azure-devops/client', () => ({
  getAzureDevOpsAuthStatus: vi.fn(async () => undefined)
}))
vi.mock('../gitea/client', () => ({ getGiteaAuthStatus: vi.fn(async () => undefined) }))

const platform = process.platform
beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  _resetPreflightCache()
})
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform })
})

it('reports glab from the default distro when no workspace names a runtime, as cwd-less glab calls use it', async () => {
  await expect(runPreflightCheck()).resolves.toMatchObject({
    glab: { installed: true, authenticated: true }
  })
  // A focused native-Windows workspace runs glab natively, so its answer stays native.
  await expect(
    runPreflightCheck(false, {
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
    })
  ).resolves.toMatchObject({ glab: { installed: false } })
  // A stopped default distro is never booted for a background read; the answer is redone once it runs.
  _resetPreflightCache()
  vi.mocked(blockedWslDistroForExec).mockResolvedValueOnce({ distro: 'Ubuntu', state: 'stopped' })
  await expect(runPreflightCheck()).resolves.toMatchObject({ glab: { installed: false } })
  await expect(runPreflightCheck()).resolves.toMatchObject({ glab: { installed: false } })
  const [distro, , onRunning] = vi.mocked(deferUntilWslDistroRunning).mock.calls[0]!
  expect(distro).toBe('Ubuntu')
  onRunning()
  await expect(runPreflightCheck()).resolves.toMatchObject({ glab: { installed: true } })
  // A forced native re-check (glab just installed on Windows) also refreshes the host-default answer.
  _resetPreflightCache()
  vi.mocked(blockedWslDistroForExec).mockResolvedValue({ distro: 'Ubuntu', state: 'stopped' })
  await expect(runPreflightCheck()).resolves.toMatchObject({ glab: { installed: false } })
  vi.mocked(findRunnableLocalCommand).mockResolvedValue({ status: 'available', binary: 'glab' })
  await runPreflightCheck(true, {
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
  })
  await expect(runPreflightCheck()).resolves.toMatchObject({ glab: { installed: true } })
})
