import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hostFallback = vi.hoisted(() => ({ cwds: new Set<string>() }))

vi.mock('./wsl-linked-worktree-git-routing', () => ({
  usesHostGitForWslLinkedWorktree: (cwd: string, wslDistro: string | undefined) =>
    Boolean(wslDistro) && hostFallback.cwds.has(cwd)
}))

import { predictLocalGitRunsIn } from './git-runs-in'
import { setLocalGitRuntimeRouter } from './local-git-runtime-route'

const originalPlatform = process.platform

beforeEach(() => {
  hostFallback.cwds.clear()
  Object.defineProperty(process, 'platform', { value: 'win32' })
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform })
  setLocalGitRuntimeRouter(null)
})

// Mirrors the runner: routeLocalGitOptions, then the host-Git linked-worktree fallback, then
// resolveCommand's UNC-over-override rule. Real wsl.exe/9P behavior is not exercised here.
describe('predictLocalGitRunsIn', () => {
  it('is always host off Windows, whatever distro the caller names', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    expect(predictLocalGitRunsIn('/src/app', 'Ubuntu')).toBe('host')
  })

  it('uses host Git for a drive path with no runtime', () => {
    expect(predictLocalGitRunsIn('C:\\src\\app')).toBe('host')
  })

  it('follows the project runtime router, and an explicit distro overrides it', () => {
    setLocalGitRuntimeRouter(() => 'Debian')
    expect(predictLocalGitRunsIn('C:\\src\\app')).toBe('wsl:debian')
    expect(predictLocalGitRunsIn('C:\\src\\app', 'Ubuntu')).toBe('wsl:ubuntu')
  })

  it('lets a UNC cwd’s distro win over the override', () => {
    expect(predictLocalGitRunsIn('\\\\wsl.localhost\\Debian\\home\\a\\app', 'Ubuntu')).toBe(
      'wsl:debian'
    )
    expect(predictLocalGitRunsIn('\\\\wsl$\\Debian\\home\\a\\app')).toBe('wsl:debian')
  })

  it('normalizes distro case', () => {
    expect(predictLocalGitRunsIn('C:\\src\\app', 'UBUNTU')).toBe(
      predictLocalGitRunsIn('C:\\src\\app', 'ubuntu')
    )
  })

  it('reports the host-Git linked-worktree fallback as host, distinct from WSL Git', () => {
    setLocalGitRuntimeRouter(() => 'Ubuntu')
    expect(predictLocalGitRunsIn('C:\\src\\wt')).toBe('wsl:ubuntu')
    hostFallback.cwds.add('C:\\src\\wt')
    expect(predictLocalGitRunsIn('C:\\src\\wt')).toBe('host')
  })
})
