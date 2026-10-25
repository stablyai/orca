import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeOs from 'node:os'

const homedirMock = vi.hoisted(() => vi.fn<() => string>())

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOs>()
  return { ...actual, homedir: homedirMock }
})

const {
  CLIENT_REMOVAL_HOME,
  executionHostRemovalHome,
  getPathOps,
  isHomeDirectoryRemovalPath,
  isRemovalHomeAuthorityResolved
} = await import('./worktree-removal-home-guard')

function isHome(
  worktreePath: string,
  home: Parameters<typeof isHomeDirectoryRemovalPath>[2]
): boolean {
  return isHomeDirectoryRemovalPath(worktreePath, getPathOps(worktreePath), home)
}

function isHomeForPair(
  worktreePath: string,
  repoPath: string,
  home: Parameters<typeof isHomeDirectoryRemovalPath>[2]
): boolean {
  return isHomeDirectoryRemovalPath(worktreePath, getPathOps(worktreePath, repoPath), home)
}

function withProcessPlatform<T>(platform: NodeJS.Platform, callback: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: platform })
  try {
    return callback()
  } finally {
    if (original) {
      Object.defineProperty(process, 'platform', original)
    }
  }
}

beforeEach(() => {
  homedirMock.mockClear()
  homedirMock.mockReturnValue('/Users/ci')
})

describe('path-shape home detection', () => {
  it.each([
    ['/home', true],
    ['/root', true],
    ['/Users', true],
    ['/home/alice', true],
    ['/Users/alice', true],
    ['/home/alice/wt/foo', false],
    ['/Users/alice/wt/foo', false],
    ['/opt/src/checkout', false]
  ])('POSIX %s -> %s', (worktreePath, expected) => {
    expect(isHome(worktreePath, CLIENT_REMOVAL_HOME)).toBe(expected)
  })

  it.each([
    ['C:\\Users', true],
    ['C:\\Users\\bob', true],
    ['c:\\users\\bob', true],
    ['D:\\Users\\bob', true],
    ['\\\\server\\share\\Users\\bob', true],
    ['C:\\Users\\bob\\wt\\foo', false],
    ['C:\\src\\repo', false]
  ])('Windows %s -> %s from a POSIX client', (worktreePath, expected) => {
    expect(withProcessPlatform('darwin', () => isHome(worktreePath, CLIENT_REMOVAL_HOME))).toBe(
      expected
    )
  })

  it.each([
    ['\\\\wsl.localhost\\Ubuntu', true],
    ['\\\\wsl.localhost\\Ubuntu\\home\\alice', true],
    ['\\\\wsl$\\Ubuntu\\home\\alice', true],
    ['\\\\wsl.localhost\\Ubuntu\\root', true],
    ['\\\\wsl.localhost\\Ubuntu\\home\\alice\\wt', false],
    ['\\\\wsl.localhost\\Ubuntu\\srv\\work', false]
  ])('WSL UNC %s -> %s', (worktreePath, expected) => {
    expect(isHome(worktreePath, CLIENT_REMOVAL_HOME)).toBe(expected)
  })

  it.each([
    // drvfs maps this Linux spelling to the Windows profile C:\Users\bob.
    ['\\\\wsl.localhost\\Ubuntu\\mnt\\c\\Users\\bob', true],
    ['\\\\wsl$\\Ubuntu\\mnt\\c\\Users', true],
    ['\\\\wsl.localhost\\Ubuntu\\mnt\\c', true],
    ['\\\\wsl.localhost\\Ubuntu\\mnt\\c\\', true],
    ['\\\\wsl.localhost\\Ubuntu\\mnt', true],
    ['\\\\wsl.localhost\\Ubuntu\\mnt\\c\\Users\\bob\\ws\\wt', false],
    ['\\\\wsl.localhost\\Ubuntu\\mnt\\c\\src\\repo', false],
    // `/MNT` is an ordinary case-sensitive Linux directory, never the automount.
    ['\\\\wsl.localhost\\Ubuntu\\MNT\\c\\Users\\bob', false]
  ])('WSL drvfs %s -> %s', (worktreePath, expected) => {
    expect(withProcessPlatform('darwin', () => isHome(worktreePath, CLIENT_REMOVAL_HOME))).toBe(
      expected
    )
  })
})

describe('whose home the guard consults', () => {
  it('never lets the client homedir answer for a foreign-syntax path', () => {
    homedirMock.mockReturnValue('/Users/ci')
    expect(withProcessPlatform('darwin', () => isHome('C:\\Users\\bob', CLIENT_REMOVAL_HOME))).toBe(
      true
    )
    expect(homedirMock).not.toHaveBeenCalled()
  })

  it('still consults the client homedir for paths in this platform s syntax', () => {
    homedirMock.mockReturnValue('/srv/homes/ci')
    expect(withProcessPlatform('linux', () => isHome('/srv', CLIENT_REMOVAL_HOME))).toBe(true)
    expect(
      withProcessPlatform('linux', () => isHome('/srv/homes/ci/wt', CLIENT_REMOVAL_HOME))
    ).toBe(false)
  })

  it('protects a non-standard home the execution host reported', () => {
    homedirMock.mockReturnValue('/Users/ci')
    const hostHome = executionHostRemovalHome('/srv/homes/alice')
    expect(isHome('/srv/homes/alice', hostHome)).toBe(true)
    // Nonstandard home paths require the executing host's answer.
    expect(isHome('/srv/homes/alice', CLIENT_REMOVAL_HOME)).toBe(false)
  })

  it('reports an unanswered execution host as unresolved, never as this client s home', () => {
    // A coinciding client home cannot resolve an unknown execution-host home.
    homedirMock.mockReturnValue('/srv/homes/alice')
    expect(isRemovalHomeAuthorityResolved(executionHostRemovalHome(null))).toBe(false)
    expect(isHome('/srv/homes/alice', executionHostRemovalHome(null))).toBe(false)
    expect(isHome('/home/alice', executionHostRemovalHome(null))).toBe(true)
    expect(homedirMock).not.toHaveBeenCalled()
  })

  it('treats an empty execution-host home as unknown rather than as a resolved answer', () => {
    expect(executionHostRemovalHome('')).toEqual({ kind: 'executionHost', homePath: null })
    expect(isRemovalHomeAuthorityResolved(executionHostRemovalHome(''))).toBe(false)
  })

  it('treats the client and an answering host as resolved', () => {
    expect(isRemovalHomeAuthorityResolved(CLIENT_REMOVAL_HOME)).toBe(true)
    expect(isRemovalHomeAuthorityResolved(executionHostRemovalHome('/srv/homes/alice'))).toBe(true)
  })

  it('honours a Windows execution-host home in the forward-slash form the relay reports', () => {
    // `normalizeRemoteHome` folds a Windows host's `$HOME` to `C:/Users/bob`, not `C:\Users\bob`.
    const hostHome = executionHostRemovalHome('C:/Users/bob/OneDrive')
    expect(withProcessPlatform('darwin', () => isHome('C:\\Users\\bob\\OneDrive', hostHome))).toBe(
      true
    )
    expect(
      withProcessPlatform('darwin', () => isHome('C:\\Users\\bob\\OneDrive\\wt\\feature', hostHome))
    ).toBe(false)
  })

  it('keeps a linked worktree under the execution host home deletable', () => {
    expect(
      isHome('/srv/homes/alice/wt/feature', executionHostRemovalHome('/srv/homes/alice'))
    ).toBe(false)
  })

  it('ignores an execution-host home written in the other platform s syntax', () => {
    expect(isHome('/srv/work', executionHostRemovalHome('C:\\Users\\bob'))).toBe(false)
    expect(isHome('C:\\work', executionHostRemovalHome('/home/alice'))).toBe(false)
    // Cross-syntax resolve invents <cwd>/C:/Users/bob and false ancestor containment.
    expect(isHome(process.cwd(), executionHostRemovalHome('C:/Users/bob'))).toBe(false)
  })

  it('honours a Windows execution-host home from a POSIX client', () => {
    expect(
      withProcessPlatform('darwin', () =>
        isHome('C:\\Users\\bob\\OneDrive', executionHostRemovalHome('C:\\Users\\bob\\OneDrive'))
      )
    ).toBe(true)
  })
})

describe('path ops chosen from the worktree/repo pair', () => {
  it('still recognises a POSIX home when the repo path drags the pair into win32 ops', () => {
    homedirMock.mockReturnValue('/Users/ci')
    expect(isHomeForPair('/home/alice', '//nas/share/repo', CLIENT_REMOVAL_HOME)).toBe(true)
    expect(isHomeForPair('/home', '//nas/share/repo', CLIENT_REMOVAL_HOME)).toBe(true)
    expect(isHomeForPair('/root', 'C:\\src\\repo', CLIENT_REMOVAL_HOME)).toBe(true)
  })

  it('still recognises the client home itself under the same contaminated ops', () => {
    homedirMock.mockReturnValue('/srv/homes/ci')
    expect(
      withProcessPlatform('linux', () =>
        isHomeForPair('/srv/homes/ci', '//nas/share/repo', CLIENT_REMOVAL_HOME)
      )
    ).toBe(true)
    expect(
      withProcessPlatform('linux', () =>
        isHomeForPair('/srv/homes/ci', 'C:\\src\\repo', CLIENT_REMOVAL_HOME)
      )
    ).toBe(true)
  })

  it('still recognises an execution-host home under the same contaminated ops', () => {
    expect(
      isHomeForPair(
        '/srv/homes/alice',
        'C:\\src\\repo',
        executionHostRemovalHome('/srv/homes/alice')
      )
    ).toBe(true)
  })

  it('keeps a linked worktree deletable when the pair is mixed-syntax', () => {
    homedirMock.mockReturnValue('/srv/homes/ci')
    expect(
      withProcessPlatform('linux', () =>
        isHomeForPair('/srv/homes/ci/wt/feature', '//nas/share/repo', CLIENT_REMOVAL_HOME)
      )
    ).toBe(false)
    expect(isHomeForPair('/opt/src/checkout', '//nas/share/repo', CLIENT_REMOVAL_HOME)).toBe(false)
  })
})
