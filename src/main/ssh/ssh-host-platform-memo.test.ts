import { beforeEach, describe, expect, it } from 'vitest'
import {
  knownSshHostPlatform,
  rememberSshHostPlatform,
  resetSshHostPlatformMemoForTests
} from './ssh-host-platform-memo'
import { getRemoteHostPlatform } from './ssh-remote-platform'

describe('ssh host platform memo', () => {
  beforeEach(() => {
    resetSshHostPlatformMemoForTests()
  })

  it('records the libc flavor, and keeps a probed one when a later report has none', () => {
    expect(knownSshHostPlatform('ssh-1')).toBeNull()
    rememberSshHostPlatform('ssh-1', getRemoteHostPlatform('linux-arm64'), 'linux-arm64-musl')
    expect(knownSshHostPlatform('ssh-1')).toEqual({ os: 'linux', arch: 'arm64', libc: 'musl' })
    rememberSshHostPlatform('ssh-1', getRemoteHostPlatform('linux-arm64'), null)
    expect(knownSshHostPlatform('ssh-1')?.libc).toBe('musl')

    rememberSshHostPlatform('ssh-2', getRemoteHostPlatform('win32-x64'), 'win32-x64')
    expect(knownSshHostPlatform('ssh-2')).toEqual({ os: 'win32', arch: 'x64', libc: 'none' })
  })
})
