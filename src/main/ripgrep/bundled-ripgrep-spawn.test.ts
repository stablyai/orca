import type { ChildProcess } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'

const wslAwareSpawnMock =
  vi.fn<(command: string, args: string[], options: Record<string, unknown>) => ChildProcess>()

vi.mock('../git/runner', () => ({ wslAwareSpawn: wslAwareSpawnMock }))
vi.mock('./bundled-ripgrep-path', () => ({
  bundledRipgrepCommand: (options?: { wsl?: boolean }) =>
    options?.wsl ? '/install/ripgrep/linux-x64/rg' : '/install/ripgrep/darwin-arm64/rg',
  bundledRipgrepWslSpawnOptions: () => ({ wslShellCommand: '<wsl-expr>' })
}))

const { spawnBundledRipgrep } = await import('./bundled-ripgrep-spawn')

function spawnOnce(options: Parameters<typeof spawnBundledRipgrep>[1]): {
  command: string
  options: Record<string, unknown>
} {
  wslAwareSpawnMock.mockClear()
  spawnBundledRipgrep(['--files'], options)
  const [command, , spawnOptions] = wslAwareSpawnMock.mock.calls[0]
  return { command, options: spawnOptions }
}

describe('spawnBundledRipgrep', () => {
  it("spawns this host's bundled binary with no WSL routing for a local workspace", () => {
    const { command, options } = spawnOnce({ cwd: '/repo' })

    expect(command).toBe('/install/ripgrep/darwin-arm64/rg')
    expect(options).not.toHaveProperty('wslDistro')
    expect(options).not.toHaveProperty('wslShellCommand')
    expect(options.cwd).toBe('/repo')
  })

  it('routes through the distro and picks the Linux build for a WSL workspace', () => {
    const { command, options } = spawnOnce({
      cwd: '\\\\wsl.localhost\\Ubuntu\\repo',
      wslDistro: 'Ubuntu',
      wslDistroForOutput: 'Ubuntu'
    })

    expect(command).toBe('/install/ripgrep/linux-x64/rg')
    expect(options.wslDistro).toBe('Ubuntu')
    expect(options.wslShellCommand).toBe('<wsl-expr>')
  })

  // Why: only rg running inside the distro emits Linux paths, so only that case rewrites the command.
  it('keeps the host build when a distro routes the spawn but output stays Windows-side', () => {
    const { command, options } = spawnOnce({ cwd: 'C:\\repo', wslDistro: 'Ubuntu' })

    expect(command).toBe('/install/ripgrep/darwin-arm64/rg')
    expect(options.wslDistro).toBe('Ubuntu')
    expect(options).not.toHaveProperty('wslShellCommand')
  })
})
