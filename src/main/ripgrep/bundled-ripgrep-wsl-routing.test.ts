import { afterEach, describe, expect, it } from 'vitest'
import { resolveBundledRipgrepWslRouting } from './bundled-ripgrep-wsl-routing'

const originalPlatform = process.platform

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
}

describe('resolveBundledRipgrepWslRouting', () => {
  afterEach(() => setPlatform(originalPlatform))

  it.each(['C:\\Users\\me\\repo', 'd:/work/repo', 'C:\\'])(
    'runs the host rg for drive root %s even under a WSL runtime',
    (rootPath) => {
      setPlatform('win32')
      expect(resolveBundledRipgrepWslRouting(rootPath, 'Ubuntu')).toEqual({})
    }
  )

  it('keeps a symlink-following scan of a drive root in WSL', () => {
    setPlatform('win32')
    expect(
      resolveBundledRipgrepWslRouting('C:\\Users\\me\\repo', 'Ubuntu', { followSymlinks: true })
    ).toEqual({ wslDistro: 'Ubuntu', wslDistroForOutput: 'Ubuntu' })
  })

  it('keeps a distro-owned UNC root inside its own distro', () => {
    setPlatform('win32')
    expect(
      resolveBundledRipgrepWslRouting('\\\\wsl.localhost\\Debian\\home\\me\\repo', 'Ubuntu')
    ).toEqual({
      wslDistro: 'Ubuntu',
      wslDistroForOutput: 'Debian'
    })
    expect(resolveBundledRipgrepWslRouting('\\\\wsl$\\Debian\\home\\me\\repo', undefined)).toEqual({
      wslDistro: undefined,
      wslDistroForOutput: 'Debian'
    })
  })

  it('leaves a plain UNC share routed by the project runtime', () => {
    setPlatform('win32')
    expect(resolveBundledRipgrepWslRouting('\\\\server\\share\\repo', 'Ubuntu')).toEqual({
      wslDistro: 'Ubuntu',
      wslDistroForOutput: 'Ubuntu'
    })
  })

  it('runs the host rg when the project has no WSL runtime', () => {
    expect(resolveBundledRipgrepWslRouting('/home/me/repo', undefined)).toEqual({
      wslDistro: undefined,
      wslDistroForOutput: undefined
    })
  })
})
