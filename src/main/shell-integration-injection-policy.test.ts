import { describe, expect, it } from 'vitest'
import {
  isShellCommandMarkerInjectionEnabled,
  resolvePowerShellCommandMarkerTrust,
  scrubShellCommandMarkerPolicyEnv,
  type ShellIntegrationHostClass
} from './shell-integration-injection-policy'

const HOST_POLICIES = [
  ['local-native', 'ORCA_DISABLE_SHELL_COMMAND_MARKERS_LOCAL_NATIVE'],
  ['local-wsl', 'ORCA_DISABLE_SHELL_COMMAND_MARKERS_LOCAL_WSL'],
  ['daemon-native', 'ORCA_DISABLE_SHELL_COMMAND_MARKERS_DAEMON_NATIVE'],
  ['daemon-wsl', 'ORCA_DISABLE_SHELL_COMMAND_MARKERS_DAEMON_WSL']
] as const satisfies readonly (readonly [ShellIntegrationHostClass, string])[]

describe('shell command marker host policy', () => {
  it.each(HOST_POLICIES)('gates %s independently', (hostClass, disableEnv) => {
    expect(isShellCommandMarkerInjectionEnabled(hostClass, {})).toBe(true)
    expect(isShellCommandMarkerInjectionEnabled(hostClass, { [disableEnv]: '1' })).toBe(false)
  })

  it('scrubs every host policy variable before spawning a shell', () => {
    const env = Object.fromEntries(HOST_POLICIES.map(([, disableEnv]) => [disableEnv, '1']))

    scrubShellCommandMarkerPolicyEnv(env)

    expect(env).toEqual({})
  })
})

describe('resolvePowerShellCommandMarkerTrust', () => {
  it('allows POSIX PowerShell without interpreting the OS release', () => {
    expect(resolvePowerShellCommandMarkerTrust('darwin', 'not-a-windows-release')).toBe(true)
    expect(resolvePowerShellCommandMarkerTrust('linux', '')).toBe(true)
  })

  it('allows Windows 11 builds and rejects older or malformed releases', () => {
    expect(resolvePowerShellCommandMarkerTrust('win32', '10.0.22000')).toBe(true)
    expect(resolvePowerShellCommandMarkerTrust('win32', '10.0.26100')).toBe(true)
    expect(resolvePowerShellCommandMarkerTrust('win32', '10.0.21999')).toBe(false)
    expect(resolvePowerShellCommandMarkerTrust('win32', '10.0.not-a-build')).toBe(false)
    expect(resolvePowerShellCommandMarkerTrust('win32', '10.0')).toBe(false)
  })
})
