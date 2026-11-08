import { describe, expect, it } from 'vitest'

import { pinnedRuntimeTargetForHost } from './pinned-runtime-host-target'

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
})
