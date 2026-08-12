import { describe, expect, it } from 'vitest'
import { listKnownVsCodeCliPaths, resolveKnownVsCodeCliPath } from './vscode-cli-install-paths'

describe('listKnownVsCodeCliPaths', () => {
  it('returns macOS Application bundle CLI paths for code', () => {
    expect(
      listKnownVsCodeCliPaths('code', {
        platform: 'darwin',
        homePath: '/Users/ada'
      })
    ).toEqual([
      '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
      '/Users/ada/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'
    ])
  })

  it('returns Insiders macOS paths for code-insiders', () => {
    expect(
      listKnownVsCodeCliPaths('code-insiders', {
        platform: 'darwin',
        homePath: '/Users/ada'
      })[0]
    ).toBe('/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code')
  })

  it('returns Windows user and Program Files bin shims', () => {
    expect(
      listKnownVsCodeCliPaths('code', {
        platform: 'win32',
        env: {
          LOCALAPPDATA: 'C:\\Users\\ada\\AppData\\Local',
          ProgramFiles: 'C:\\Program Files'
        }
      })
    ).toEqual([
      'C:\\Users\\ada\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd',
      'C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd'
    ])
  })

  it('ignores non-VS Code launchers', () => {
    expect(listKnownVsCodeCliPaths('cursor', { platform: 'darwin' })).toEqual([])
    expect(listKnownVsCodeCliPaths('zed', { platform: 'linux' })).toEqual([])
  })
})

describe('resolveKnownVsCodeCliPath', () => {
  it('returns the first existing known path', () => {
    const macPath = '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'
    expect(
      resolveKnownVsCodeCliPath('code', (candidate) => candidate === macPath, {
        platform: 'darwin',
        homePath: '/Users/ada'
      })
    ).toBe(macPath)
  })

  it('returns null when no known path exists', () => {
    expect(
      resolveKnownVsCodeCliPath('code', () => false, {
        platform: 'darwin',
        homePath: '/Users/ada'
      })
    ).toBeNull()
  })
})
