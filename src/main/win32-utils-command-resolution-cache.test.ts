import { delimiter, join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { resolveWindowsCommand as ResolveWindowsCommand } from './win32-utils'

const { existsSyncMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn<(path: string) => boolean>()
}))

vi.mock('node:fs', () => ({ existsSync: existsSyncMock }))

const DIR_A = join('/fake', 'a')
const DIR_B = join('/fake', 'b')
const PATH_AB = [DIR_A, DIR_B].join(delimiter)

async function importFreshResolver(): Promise<typeof ResolveWindowsCommand> {
  // Fresh module per test so the module-level memo starts empty.
  vi.resetModules()
  return (await import('./win32-utils')).resolveWindowsCommand
}

function withWin32<T>(fn: () => T): T {
  const original = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  try {
    return fn()
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: original })
  }
}

beforeEach(() => {
  vi.restoreAllMocks()
  existsSyncMock.mockReset().mockReturnValue(false)
  vi.spyOn(Date, 'now').mockReturnValue(100_000)
})

describe('resolveWindowsCommand memoization', () => {
  it('probes once, then serves an identical (command, PATH) resolution with zero fs calls', async () => {
    const resolveWindowsCommand = await importFreshResolver()
    const ghShim = join(DIR_B, 'gh.exe')
    existsSyncMock.mockImplementation((path) => path === ghShim)

    withWin32(() => {
      expect(resolveWindowsCommand('gh', { PATH: PATH_AB })).toBe(ghShim)
    })
    const probesForFirstResolution = existsSyncMock.mock.calls.length
    expect(probesForFirstResolution).toBeGreaterThan(0)

    withWin32(() => {
      expect(resolveWindowsCommand('gh', { PATH: PATH_AB })).toBe(ghShim)
    })
    expect(existsSyncMock.mock.calls.length).toBe(probesForFirstResolution)
  })

  it('re-probes when the PATH string changes', async () => {
    const resolveWindowsCommand = await importFreshResolver()
    const ghInA = join(DIR_A, 'gh.cmd')
    const ghInB = join(DIR_B, 'gh.cmd')
    existsSyncMock.mockImplementation((path) => path === ghInA || path === ghInB)

    withWin32(() => {
      expect(resolveWindowsCommand('gh', { PATH: DIR_A })).toBe(ghInA)
      expect(resolveWindowsCommand('gh', { PATH: DIR_B })).toBe(ghInB)
    })
  })

  it('does not serve one command’s entry for another', async () => {
    const resolveWindowsCommand = await importFreshResolver()
    const ghShim = join(DIR_A, 'gh.cmd')
    existsSyncMock.mockImplementation((path) => path === ghShim)

    withWin32(() => {
      expect(resolveWindowsCommand('gh', { PATH: PATH_AB })).toBe(ghShim)
      expect(resolveWindowsCommand('glab', { PATH: PATH_AB })).toBe('glab')
    })
  })

  it('caches a miss briefly, then finds a CLI installed mid-session after the retry window', async () => {
    const resolveWindowsCommand = await importFreshResolver()

    withWin32(() => {
      expect(resolveWindowsCommand('glab', { PATH: PATH_AB })).toBe('glab')
    })
    const probesForFirstResolution = existsSyncMock.mock.calls.length

    // Within the retry window: the miss is served from the memo, no re-scan.
    vi.spyOn(Date, 'now').mockReturnValue(100_000 + 29_999)
    withWin32(() => {
      expect(resolveWindowsCommand('glab', { PATH: PATH_AB })).toBe('glab')
    })
    expect(existsSyncMock.mock.calls.length).toBe(probesForFirstResolution)

    // Past the window with the CLI now installed: the re-probe finds it.
    const glabShim = join(DIR_A, 'glab.exe')
    existsSyncMock.mockImplementation((path) => path === glabShim)
    vi.spyOn(Date, 'now').mockReturnValue(100_000 + 30_000)
    withWin32(() => {
      expect(resolveWindowsCommand('glab', { PATH: PATH_AB })).toBe(glabShim)
    })
    expect(existsSyncMock.mock.calls.length).toBeGreaterThan(probesForFirstResolution)

    // The hit is now pinned: a later identical resolution does no fs work.
    const probesAfterInstall = existsSyncMock.mock.calls.length
    vi.spyOn(Date, 'now').mockReturnValue(100_000 + 500_000)
    withWin32(() => {
      expect(resolveWindowsCommand('glab', { PATH: PATH_AB })).toBe(glabShim)
    })
    expect(existsSyncMock.mock.calls.length).toBe(probesAfterInstall)
  })

  it('bypasses the memo entirely off win32 and for explicit paths', async () => {
    const resolveWindowsCommand = await importFreshResolver()

    expect(resolveWindowsCommand('gh', { PATH: PATH_AB })).toBe('gh')
    withWin32(() => {
      expect(resolveWindowsCommand(join('C:', 'tools', 'gh.exe'), { PATH: PATH_AB })).toBe(
        join('C:', 'tools', 'gh.exe')
      )
    })
    expect(existsSyncMock).not.toHaveBeenCalled()
  })
})
