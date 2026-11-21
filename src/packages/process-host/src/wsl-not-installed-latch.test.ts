import { afterEach, describe, expect, it } from 'vitest'
import { resolveSpawn } from './spawn-resolution'
import {
  WSL_NOT_INSTALLED_CODE,
  _resetWslNotInstalledLatchForTests,
  latchWslNotInstalled
} from './wsl-not-installed-latch'

const WSL = 'C:\\Windows\\System32\\wsl.exe'

describe('WSL not-installed latch', () => {
  afterEach(() => {
    _resetWslNotInstalledLatchForTests()
  })

  it('lets wsl.exe spawn until absence is latched', () => {
    expect(resolveSpawn({ program: WSL, args: ['-d', 'Ubuntu'] }, 'win32').file).toBe(WSL)
  })

  it('refuses every wsl.exe form once latched, and nothing else', () => {
    latchWslNotInstalled()
    for (const program of [WSL, 'wsl.exe', 'wsl', 'C:/Windows/System32/WSL.EXE']) {
      expect(() => resolveSpawn({ program, args: ['--list', '--quiet'] }, 'win32')).toThrow(
        expect.objectContaining({ code: WSL_NOT_INSTALLED_CODE })
      )
    }
    expect(resolveSpawn({ program: 'C:\\Windows\\System32\\sc.exe' }, 'win32').file).toContain(
      'sc.exe'
    )
  })
})
