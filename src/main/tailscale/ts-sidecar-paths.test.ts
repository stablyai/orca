import { describe, expect, it } from 'vitest'
import {
  tsSidecarBinaryCandidates,
  tsSidecarBinaryName,
  tsSidecarStateDir
} from './ts-sidecar-paths'

describe('tsSidecarBinaryName', () => {
  it('encodes platform and arch, no extension on posix', () => {
    expect(tsSidecarBinaryName('darwin', 'arm64')).toBe('ts-sidecar-darwin-arm64')
    expect(tsSidecarBinaryName('linux', 'x64')).toBe('ts-sidecar-linux-x64')
  })

  it('adds .exe on Windows', () => {
    expect(tsSidecarBinaryName('win32', 'x64')).toBe('ts-sidecar-win32-x64.exe')
  })
})

describe('tsSidecarBinaryCandidates', () => {
  it('prefers packaged resources over the dev build output', () => {
    const candidates = tsSidecarBinaryCandidates({
      platform: 'darwin',
      arch: 'arm64',
      resourcesPath: '/App/Contents/Resources',
      appPath: '/repo'
    })
    expect(candidates).toEqual([
      '/App/Contents/Resources/ts-sidecar/ts-sidecar-darwin-arm64',
      '/repo/native/ts-sidecar/ts-sidecar-darwin-arm64'
    ])
  })

  it('falls back to only the dev path when no resources dir is known', () => {
    const candidates = tsSidecarBinaryCandidates({
      platform: 'linux',
      arch: 'x64',
      appPath: '/repo'
    })
    expect(candidates).toEqual(['/repo/native/ts-sidecar/ts-sidecar-linux-x64'])
  })
})

describe('tsSidecarStateDir', () => {
  it('nests tailnet state under userData', () => {
    expect(tsSidecarStateDir('/home/u/.orca/userData')).toBe('/home/u/.orca/userData/tailnet')
  })
})
