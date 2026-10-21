import { afterEach, describe, expect, it, vi } from 'vitest'
import { filterPathsToRunningWslDistrosAsync } from './wsl-running-path-filter'
import { listRunningWslDistrosAsync } from './wsl'

vi.mock('./wsl', () => ({ listRunningWslDistrosAsync: vi.fn() }))

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetAllMocks()
})

describe('filterPathsToRunningWslDistrosAsync', () => {
  it.each([[], ['C:\\Users\\user\\.codex'], ['\\\\server\\share', '/local/path']])(
    'does not query WSL for native paths %j',
    async (...paths: string[]) => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
      const result = await filterPathsToRunningWslDistrosAsync(paths)
      expect(result).toEqual(paths)
      expect(result).not.toBe(paths)
      expect(listRunningWslDistrosAsync).not.toHaveBeenCalled()
    }
  )

  it('still queries running distros for a mixed list and preserves path order', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    vi.mocked(listRunningWslDistrosAsync).mockResolvedValue(['Ubuntu'])
    const paths = [
      'C:\\local',
      '\\\\wsl$\\ubuntu\\home',
      '//wsl.localhost/Debian/home',
      'D:\\local'
    ]
    expect(await filterPathsToRunningWslDistrosAsync(paths)).toEqual([paths[0], paths[1], paths[3]])
    expect(listRunningWslDistrosAsync).toHaveBeenCalledTimes(1)
  })

  it('does not interpret WSL-shaped paths on a non-Windows host', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    const paths = ['//wsl.localhost/Ubuntu/home']
    expect(await filterPathsToRunningWslDistrosAsync(paths)).toEqual(paths)
    expect(listRunningWslDistrosAsync).not.toHaveBeenCalled()
  })
})
