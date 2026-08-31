import { describe, expect, it } from 'vitest'
import {
  compareDottedVersions,
  detectLibcFromReportHeader,
  detectNativeHostAbi,
  GLIBC_FLOOR,
  isBelowGlibcFloor,
  nativeSlotName,
  parseNodeAbiMismatch,
  parseUnmetGlibcVersion
} from './native-host-abi'

describe('detectLibcFromReportHeader', () => {
  it('reads glibc and its version from a glibc host report', () => {
    expect(detectLibcFromReportHeader('linux', { glibcVersionRuntime: '2.31' })).toEqual({
      libc: 'glibc',
      glibcVersion: '2.31'
    })
  })

  it('calls a Linux report with no glibcVersionRuntime musl', () => {
    // Alpine's Node omits the key entirely; that absence is the only signal available
    // without shelling out to ldd, which musl images do not usefully provide.
    expect(detectLibcFromReportHeader('linux', { arch: 'x64' })).toEqual({
      libc: 'musl',
      glibcVersion: null
    })
  })

  it('does not invent a libc dimension for macOS or Windows', () => {
    // A darwin-arm64-glibc slot would never match anything CI builds.
    expect(detectLibcFromReportHeader('darwin', { glibcVersionRuntime: '2.31' }).libc).toBe('none')
    expect(detectLibcFromReportHeader('win32', undefined).libc).toBe('none')
  })

  it('treats an unreadable report as glibc with an unknown version, not as musl', () => {
    // Guessing musl would send a glibc host looking for a slot that does not exist.
    expect(detectLibcFromReportHeader('linux', undefined)).toEqual({
      libc: 'glibc',
      glibcVersion: null
    })
  })
})

describe('nativeSlotName', () => {
  it('carries libc on Linux and omits it elsewhere', () => {
    expect(nativeSlotName({ platform: 'linux', arch: 'x64', libc: 'glibc' })).toBe(
      'linux-x64-glibc'
    )
    expect(nativeSlotName({ platform: 'linux', arch: 'arm64', libc: 'musl' })).toBe(
      'linux-arm64-musl'
    )
    expect(nativeSlotName({ platform: 'darwin', arch: 'arm64', libc: 'none' })).toBe('darwin-arm64')
  })

  it('never lets a glibc slot answer for a musl host', () => {
    // node-pty's own loader checks prebuilds/<platform>-<arch> with no libc, which is the
    // exact confusion this name exists to prevent.
    expect(nativeSlotName({ platform: 'linux', arch: 'x64', libc: 'glibc' })).not.toBe(
      nativeSlotName({ platform: 'linux', arch: 'x64', libc: 'musl' })
    )
  })
})

describe('glibc floor', () => {
  it('compares dotted versions numerically, not lexically', () => {
    // '2.9' > '2.31' under string compare; that ordering would pass a broken host.
    expect(compareDottedVersions('2.9', '2.31')).toBe(-1)
    expect(compareDottedVersions('2.31', '2.31.0')).toBe(0)
    expect(compareDottedVersions('2.34', GLIBC_FLOOR)).toBe(1)
  })

  it('answers null when the version is unknown rather than claiming the floor is met', () => {
    expect(isBelowGlibcFloor(null)).toBeNull()
    expect(isBelowGlibcFloor('2.28')).toBe(true)
    expect(isBelowGlibcFloor('2.31')).toBe(false)
  })
})

describe('loader error parsing', () => {
  it('extracts the unmet symbol version from the #9902 message', () => {
    expect(
      parseUnmetGlibcVersion(
        "/lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.34' not found (required by /app/node_modules/node-pty/build/Release/pty.node)"
      )
    ).toBe('2.34')
  })

  it('ignores unrelated loader noise', () => {
    expect(parseUnmetGlibcVersion('Error: Cannot find module ./pty.node')).toBeNull()
  })

  it('extracts both ABI numbers from a NODE_MODULE_VERSION mismatch', () => {
    expect(
      parseNodeAbiMismatch(
        'was compiled against a different Node.js version using NODE_MODULE_VERSION 115. This version of Node.js requires NODE_MODULE_VERSION 127.'
      )
    ).toEqual({ built: '115', host: '127' })
  })
})

describe('detectNativeHostAbi', () => {
  it('describes the host this test is running on', () => {
    const abi = detectNativeHostAbi()
    expect(abi.platform).toBe(process.platform)
    expect(abi.arch).toBe(process.arch)
    expect(abi.nodeAbi).toBe(process.versions.modules)
    expect(abi.libc).toBe(process.platform === 'linux' ? abi.libc : 'none')
  })
})
