import { describe, expect, it } from 'vitest'
import { archesForPlatform, goEnvFor, sidecarBinaryName } from './build-ts-sidecar.mjs'

describe('sidecarBinaryName', () => {
  it('embeds platform and arch and adds .exe only on Windows', () => {
    expect(sidecarBinaryName('darwin', 'arm64')).toBe('ts-sidecar-darwin-arm64')
    expect(sidecarBinaryName('linux', 'x64')).toBe('ts-sidecar-linux-x64')
    expect(sidecarBinaryName('win32', 'x64')).toBe('ts-sidecar-win32-x64.exe')
  })
})

describe('goEnvFor', () => {
  it('maps node platform/arch to GOOS/GOARCH', () => {
    expect(goEnvFor('win32', 'x64')).toEqual({ GOOS: 'windows', GOARCH: 'amd64' })
    expect(goEnvFor('darwin', 'arm64')).toEqual({ GOOS: 'darwin', GOARCH: 'arm64' })
    expect(goEnvFor('linux', 'x64')).toEqual({ GOOS: 'linux', GOARCH: 'amd64' })
  })

  it('rejects unsupported platforms and arches', () => {
    expect(() => goEnvFor('solaris', 'x64')).toThrow(/Unsupported platform/)
    expect(() => goEnvFor('linux', 'mips')).toThrow(/Unsupported arch/)
  })
})

describe('archesForPlatform', () => {
  it('lists the arches electron-builder may package', () => {
    expect(archesForPlatform('darwin')).toEqual(['arm64', 'x64'])
    expect(archesForPlatform('win32')).toEqual(['x64'])
  })
})
