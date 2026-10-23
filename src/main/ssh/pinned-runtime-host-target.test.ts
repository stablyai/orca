import { describe, expect, it } from 'vitest'
import { NODE_RUNTIME_ASSETS, NODE_RUNTIME_COMPAT_ASSETS } from '../../shared/node-runtime-pin'
import {
  isGlibcBelow,
  nodeRuntimeStorePins,
  pinnedRuntimeTargetForHost
} from './pinned-runtime-host-target'

describe('pinned runtime host target', () => {
  it('names the runtime a host can run by glibc alone', () => {
    expect(
      pinnedRuntimeTargetForHost({ target: 'linux-x64-glibc', glibc: { major: 2, minor: 28 } })
    ).toBe('linux-x64-glibc')
    expect(
      pinnedRuntimeTargetForHost({ target: 'linux-x64-glibc', glibc: { major: 2, minor: 27 } })
    ).toBe('linux-x64-glibc217')
    expect(
      pinnedRuntimeTargetForHost({ target: 'linux-x64-glibc', glibc: { major: 2, minor: 17 } })
    ).toBe('linux-x64-glibc217')
    expect(
      pinnedRuntimeTargetForHost({ target: 'linux-x64-glibc', glibc: { major: 2, minor: 12 } })
    ).toBeNull()
    expect(
      pinnedRuntimeTargetForHost({ target: 'linux-arm64-glibc', glibc: { major: 2, minor: 17 } })
    ).toBeNull()
    expect(pinnedRuntimeTargetForHost({ target: 'linux-x64-glibc', glibc: null })).toBe(
      'linux-x64-glibc'
    )
    expect(pinnedRuntimeTargetForHost({ target: 'linux-x64-musl', glibc: null })).toBe(
      'linux-x64-musl'
    )
  })

  it('keeps the compat runtime pinned in the store beside the default one', () => {
    const defaultSha = NODE_RUNTIME_ASSETS['linux-x64-glibc'].executableSha256
    const compatSha = NODE_RUNTIME_COMPAT_ASSETS['linux-x64-glibc217'].executableSha256
    expect(nodeRuntimeStorePins('linux-x64-glibc')).toEqual([defaultSha, compatSha])
    expect(nodeRuntimeStorePins('linux-x64-glibc217')).toEqual([defaultSha, compatSha])
    expect(nodeRuntimeStorePins('linux-arm64-glibc')).toEqual([
      NODE_RUNTIME_ASSETS['linux-arm64-glibc'].executableSha256
    ])
  })

  it('compares glibc versions by major, then minor', () => {
    expect(isGlibcBelow({ major: 2, minor: 27 }, { major: 2, minor: 28 })).toBe(true)
    expect(isGlibcBelow({ major: 2, minor: 28 }, { major: 2, minor: 28 })).toBe(false)
    expect(isGlibcBelow({ major: 1, minor: 99 }, { major: 2, minor: 0 })).toBe(true)
    expect(isGlibcBelow({ major: 3, minor: 0 }, { major: 2, minor: 99 })).toBe(false)
  })
})
