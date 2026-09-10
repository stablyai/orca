import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeOs from 'node:os'

const homedirMock = vi.hoisted(() => vi.fn<() => string>())

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOs>()
  return { ...actual, homedir: homedirMock }
})

const { CLIENT_REMOVAL_HOME, executionHostRemovalHome, getPathOps, isHomeDirectoryRemovalPath } =
  await import('./worktree-removal-home-guard')

function isHome(
  worktreePath: string,
  home: Parameters<typeof isHomeDirectoryRemovalPath>[2]
): boolean {
  const pathOps = getPathOps(worktreePath)
  return isHomeDirectoryRemovalPath(pathOps.resolve(worktreePath), pathOps, home)
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
})

describe('whose home the guard consults', () => {
  it('never lets the client homedir answer for a foreign-syntax path', () => {
    // A Windows host profile is dangerous from a macOS desktop whose own home
    // is `/Users/ci` — the verdict comes from path shape, not `os.homedir()`.
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
    // Without the host's answer the same path has no recognisable home shape,
    // which is exactly why the client home must not stand in for it.
    expect(isHome('/srv/homes/alice', CLIENT_REMOVAL_HOME)).toBe(false)
    expect(isHome('/srv/homes/alice', executionHostRemovalHome(null))).toBe(false)
  })

  it('keeps a linked worktree under the execution host home deletable', () => {
    expect(
      isHome('/srv/homes/alice/wt/feature', executionHostRemovalHome('/srv/homes/alice'))
    ).toBe(false)
  })

  it('ignores an execution-host home written in the other platform s syntax', () => {
    expect(isHome('/srv/work', executionHostRemovalHome('C:\\Users\\bob'))).toBe(false)
    expect(isHome('C:\\work', executionHostRemovalHome('/home/alice'))).toBe(false)
  })

  it('honours a Windows execution-host home from a POSIX client', () => {
    expect(
      withProcessPlatform('darwin', () =>
        isHome('C:\\Users\\bob\\OneDrive', executionHostRemovalHome('C:\\Users\\bob\\OneDrive'))
      )
    ).toBe(true)
  })
})
