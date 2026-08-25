import { describe, expect, it } from 'vitest'
import { gitExecutionHostForTarget, gitExecutionHostKey } from './git-execution-host'

const UNC_UBUNTU = String.raw`\\wsl.localhost\Ubuntu\home\user\repo`
const UNC_DOLLAR_DEBIAN = String.raw`\\wsl$\Debian\home\user\repo`

const keyFor = (target: Parameters<typeof gitExecutionHostForTarget>[0]): string =>
  gitExecutionHostKey(gitExecutionHostForTarget(target))

describe('gitExecutionHostForTarget', () => {
  it('reads the distro out of either WSL UNC spelling', () => {
    expect(gitExecutionHostForTarget({ cwd: UNC_UBUNTU })).toEqual({
      kind: 'wsl',
      distro: 'Ubuntu',
      cwdLinuxPath: '/home/user/repo'
    })
    expect(gitExecutionHostForTarget({ cwd: UNC_DOLLAR_DEBIAN })).toEqual({
      kind: 'wsl',
      distro: 'Debian',
      cwdLinuxPath: '/home/user/repo'
    })
  })

  it('treats a plain path as native', () => {
    expect(gitExecutionHostForTarget({ cwd: String.raw`C:\repo` })).toEqual({ kind: 'native' })
    expect(gitExecutionHostForTarget({ cwd: '/home/user/repo' })).toEqual({ kind: 'native' })
    expect(gitExecutionHostForTarget({})).toEqual({ kind: 'native' })
  })

  it('applies the hint only when the cwd cannot name a distro', () => {
    expect(gitExecutionHostForTarget({ wslDistro: 'Ubuntu' })).toEqual({
      kind: 'wsl',
      distro: 'Ubuntu',
      cwdLinuxPath: null
    })
    expect(gitExecutionHostForTarget({ cwd: String.raw`C:\repo`, wslDistro: 'Ubuntu' })).toEqual({
      kind: 'wsl',
      distro: 'Ubuntu',
      cwdLinuxPath: null
    })
  })

  // The precedence that matters: git runs where the cwd points, so a hint naming
  // a different distro must not rename the host.
  it('lets the cwd win over a hint that names a different distro', () => {
    expect(gitExecutionHostForTarget({ cwd: UNC_UBUNTU, wslDistro: 'Debian' })).toEqual({
      kind: 'wsl',
      distro: 'Ubuntu',
      cwdLinuxPath: '/home/user/repo'
    })
  })

  // The one route that overrides the name: a prepared Windows-authored linked
  // worktree runs git.exe on the host even though the caller still carries a hint.
  it('reports native once the linked-worktree probe says git runs on the host', () => {
    expect(
      gitExecutionHostForTarget({
        cwd: String.raw`C:\repo\linked`,
        wslDistro: 'Ubuntu',
        usesHostGit: true
      })
    ).toEqual({ kind: 'native' })
    expect(
      keyFor({ cwd: String.raw`C:\repo\linked`, wslDistro: 'Ubuntu', usesHostGit: true })
    ).toBe(keyFor({}))
  })

  it('keys native hosts together and each distro apart', () => {
    expect(keyFor({ cwd: '/repo-a' })).toBe(keyFor({ cwd: '/repo-b' }))
    expect(keyFor({ cwd: UNC_UBUNTU })).toBe(keyFor({ wslDistro: 'Ubuntu' }))
    expect(keyFor({ wslDistro: 'Ubuntu' })).not.toBe(keyFor({ wslDistro: 'Debian' }))
    expect(keyFor({})).not.toBe(keyFor({ wslDistro: 'Ubuntu' }))
  })

  // Windows folds distro case, so two spellings of one distro must not each pay
  // for its own capability probing.
  it('keys both UNC spellings of one distro together while passing it through verbatim', () => {
    expect(keyFor({ cwd: String.raw`\\wsl$\ubuntu\home\u\repo` })).toBe(keyFor({ cwd: UNC_UBUNTU }))
    expect(keyFor({ wslDistro: 'UBUNTU' })).toBe(keyFor({ wslDistro: 'Ubuntu' }))
    expect(gitExecutionHostForTarget({ wslDistro: 'UBUNTU' })).toMatchObject({ distro: 'UBUNTU' })
  })
})
