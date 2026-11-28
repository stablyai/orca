import { afterEach, expect, it, vi } from 'vitest'
import type { ExecFileCaptureOptions } from './process-capture/exec-file-capture'
import { gitExecFileAsync } from './git-exec-file'

vi.mock('./host-routing/wsl-git-read-environment', () => ({
  isWslGitReadEnvironmentSettled: () => true,
  peekWslGitReadEnvironment: () => ({
    gitPath: '/usr/bin/git',
    home: '/fixture/home',
    path: '/usr/bin'
  }),
  invalidateWslGitReadEnvironment: () => {}
}))

vi.mock('./process-capture/exec-file-capture', () => ({
  execFileCapture: async (_command: string, argv: string[], options: ExecFileCaptureOptions) => {
    options.onChildTerminated?.()
    const [distroFlag, distro, execFlag, program, mode] = argv
    if (distroFlag !== '-d' || distro !== 'DeBiaN' || execFlag !== '--exec') {
      throw new Error('Unexpected WSL command for the fixture worktree')
    }
    if (program === '/usr/bin/env') {
      throw Object.assign(new Error('git not found'), { code: 127, stderr: 'git not found' })
    }
    if (program !== 'sh' || mode !== '-lc') {
      throw new Error('Expected login-shell fallback')
    }
    return { stdout: 'refs/heads/feature\n', stderr: '' }
  }
}))

const originalPlatform = process.platform
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform })
  vi.unstubAllEnvs()
})

it('reports the UNC distro for both the direct WSL Git attempt and its login fallback', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  vi.stubEnv('ORCA_INTERNAL_WSL_DISTRO_ALLOWLIST', 'debian')
  const runtimes: string[] = []
  const result = await gitExecFileAsync(['for-each-ref', 'refs/heads'], {
    cwd: '\\\\wsl.localhost\\DeBiaN\\fixture\\repo',
    wslDistro: 'Ubuntu',
    preferWslDirectGit: true,
    observeGitRuntime: (runsIn) => runtimes.push(runsIn)
  })

  expect(result.stdout).toBe('refs/heads/feature\n')
  expect(runtimes).toEqual(['wsl:debian', 'wsl:debian'])
})
