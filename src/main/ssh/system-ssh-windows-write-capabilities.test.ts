/**
 * Whether a Windows host has an sftp subsystem is a fact about that host, so the cache is keyed by
 * the endpoint that executes rather than by Orca's target id — otherwise a hardened host is
 * re-probed once per file, and two targets pointing at one machine learn the same fact twice.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { SshTarget } from '../../shared/ssh-types'
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

    // A target re-created under a new id has not changed what the host supports.
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

    // No PowerShell 7 says nothing about whether the host will serve sftp.
    expect(capabilities.shouldTry('sftp-subsystem')).toBe(true)
    expect(capabilities.shouldTry('pwsh')).toBe(false)
  })
})
