import { describe, expect, it } from 'vitest'
import { normalizeWslColdRestoreCwd } from './wsl-cold-restore-cwd'

const base = {
  platform: 'win32' as const,
  hostname: 'DESKTOP-ORCA',
  requestedCwd: '\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo',
  wslDistro: 'Ubuntu'
}

describe('normalizeWslColdRestoreCwd', () => {
  it.each([
    ['C:\\work', 'C:\\work'],
    ['\\\\wsl.localhost\\ubuntu\\home\\jin', '\\\\wsl.localhost\\ubuntu\\home\\jin'],
    ['/home/jin', '\\\\wsl.localhost\\Ubuntu\\home\\jin'],
    ['\\\\desktop-orca\\home\\jin', '\\\\wsl.localhost\\Ubuntu\\home\\jin'],
    ['\\\\DESKTOP-ORCA\\mnt\\c\\work', 'C:\\work']
  ])('allows or repairs %s', (recoveredCwd, expected) => {
    expect(normalizeWslColdRestoreCwd({ ...base, recoveredCwd })).toBe(expected)
  })

  it.each([
    '\\\\wsl.localhost\\Debian\\home\\jin',
    '\\\\server\\share\\repo',
    '//server/share/repo',
    'relative/path',
    '\\\\other-host\\home\\jin'
  ])('falls back instead of guessing for %s', (recoveredCwd) => {
    expect(normalizeWslColdRestoreCwd({ ...base, recoveredCwd })).toBe(base.requestedCwd)
  })

  it('leaves native and missing-context restores unchanged', () => {
    expect(
      normalizeWslColdRestoreCwd({ ...base, platform: 'linux', recoveredCwd: '/home/jin' })
    ).toBe('/home/jin')
    expect(
      normalizeWslColdRestoreCwd({ ...base, wslDistro: undefined, recoveredCwd: '\\\\server\\x' })
    ).toBe('\\\\server\\x')
  })
})
