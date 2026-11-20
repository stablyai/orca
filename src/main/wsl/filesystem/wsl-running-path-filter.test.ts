import { afterEach, describe, expect, it, vi } from 'vitest'
import { filterPathsToRunningWslDistrosAsync } from './wsl-running-path-filter'
import { listRunningWslDistrosAsync } from '../discovery/distro-catalog'

vi.mock('../discovery/distro-catalog', () => ({ listRunningWslDistrosAsync: vi.fn() }))

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetAllMocks()
})

describe('filterPathsToRunningWslDistrosAsync', () => {
  it('filters stopped distros from a mixed list and preserves path order', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    vi.mocked(listRunningWslDistrosAsync).mockResolvedValue(['Ubuntu'])
    const paths = [
      'C:\\local',
      '\\\\wsl$\\ubuntu\\home',
      '//wsl.localhost/Debian/home',
      'D:\\local'
    ]
    expect(await filterPathsToRunningWslDistrosAsync(paths)).toEqual([paths[0], paths[1], paths[3]])
  })
})
