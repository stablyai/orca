/** Cache by execution endpoint so target re-creation and duplicate target rows share host facts. */
import { afterEach, describe, expect, it } from 'vitest'
import type { SshTarget } from '../../../shared/ssh-types'
import {
  clearWindowsRemoteWriteCapabilitiesForTests,
  getWindowsRemoteWriteCapabilities,
  getWindowsRemoteWriteExecutionHostKey
} from './system-ssh-windows-write-capabilities'

const asTarget = (fields: Partial<SshTarget>): SshTarget => fields as SshTarget

afterEach(() => {
  clearWindowsRemoteWriteCapabilitiesForTests()
})

describe('getWindowsRemoteWriteExecutionHostKey', () => {
  it('gives two targets on one endpoint the same key', () => {
    const first = asTarget({ id: 'a', host: 'win.example', username: 'dev', port: 22 })
    const second = asTarget({ id: 'b', host: 'win.example', username: 'dev', port: 22 })

    expect(getWindowsRemoteWriteExecutionHostKey(first)).toBe(
      getWindowsRemoteWriteExecutionHostKey(second)
    )
  })

  it('separates hosts, ports and users', () => {
    const base = { id: 'a', host: 'win.example', username: 'dev', port: 22 }
    const keys = [
      asTarget(base),
      asTarget({ ...base, host: 'other.example' }),
      asTarget({ ...base, port: 2222 }),
      asTarget({ ...base, username: 'ops' })
    ].map(getWindowsRemoteWriteExecutionHostKey)

    expect(new Set(keys).size).toBe(4)
  })

  it('keys a config alias by the alias, since ssh_config decides where it lands', () => {
    const alias = asTarget({ id: 'a', host: 'stale.example', configHost: 'winbox' })

    expect(getWindowsRemoteWriteExecutionHostKey(alias)).toBe('config:winbox')
  })
})

describe('getWindowsRemoteWriteCapabilities', () => {
  it('shares one cache across targets that reach the same host', () => {
    const first = asTarget({ id: 'a', host: 'win.example', username: 'dev', port: 22 })
    const second = asTarget({ id: 'b', host: 'win.example', username: 'dev', port: 22 })

    getWindowsRemoteWriteCapabilities(first).rememberUnsupported('sftp-subsystem')

    expect(getWindowsRemoteWriteCapabilities(second).shouldTry('sftp-subsystem')).toBe(false)
  })

  it('does not let one host answer for another', () => {
    const hardened = asTarget({ id: 'a', host: 'hardened.example', username: 'dev', port: 22 })
    const ordinary = asTarget({ id: 'b', host: 'ordinary.example', username: 'dev', port: 22 })

    getWindowsRemoteWriteCapabilities(hardened).rememberUnsupported('sftp-subsystem')

    expect(getWindowsRemoteWriteCapabilities(ordinary).shouldTry('sftp-subsystem')).toBe(true)
  })

  it('keeps the two capabilities independent', () => {
    const target = asTarget({ id: 'a', host: 'win.example', username: 'dev', port: 22 })
    const capabilities = getWindowsRemoteWriteCapabilities(target)

    capabilities.rememberUnsupported('pwsh')

    expect(capabilities.shouldTry('sftp-subsystem')).toBe(true)
    expect(capabilities.shouldTry('pwsh')).toBe(false)
  })

  it('bounds host capability entries while retaining recent hosts', () => {
    const first = asTarget({ id: 'first', host: 'win-first.example', username: 'dev' })
    getWindowsRemoteWriteCapabilities(first).rememberUnsupported('sftp-subsystem')
    for (let index = 0; index < 260; index += 1) {
      getWindowsRemoteWriteCapabilities(
        asTarget({ id: String(index), host: `win-${index}.example`, username: 'dev' })
      )
    }
    expect(getWindowsRemoteWriteCapabilities(first).shouldTry('sftp-subsystem')).toBe(true)
  })
})
