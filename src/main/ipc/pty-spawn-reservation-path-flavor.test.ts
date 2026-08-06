import { describe, expect, it } from 'vitest'
import { resolvePaneSpawnReservationPathFlavor } from './pty-spawn-reservation-path-flavor'

describe('pane spawn reservation path flavor', () => {
  it.each([
    ['Linux local', 'linux' as const, 'native', 'posix'],
    ['macOS local', 'darwin' as const, 'native', 'posix'],
    ['Windows local', 'win32' as const, 'native', 'windows'],
    ['WSL on Windows', 'win32' as const, 'wsl:Ubuntu', 'windows'],
    ['WSL from a non-Windows controller', 'linux' as const, 'wsl:Ubuntu', 'windows']
  ])('routes %s filesystem semantics', (_label, localPlatform, executionRuntime, expected) => {
    expect(resolvePaneSpawnReservationPathFlavor({ executionRuntime, localPlatform })).toBe(
      expected
    )
  })

  it.each([
    ['direct SSH Linux', 'posix' as const, 'posix'],
    ['relay macOS', 'posix' as const, 'posix'],
    ['direct SSH Windows', 'windows' as const, 'windows'],
    ['relay Windows', 'windows' as const, 'windows']
  ])('uses authoritative %s filesystem semantics', (_label, remotePathFlavor, expected) => {
    expect(
      resolvePaneSpawnReservationPathFlavor({
        connectionId: 'ssh-1',
        executionRuntime: 'ssh',
        remotePathFlavor,
        localPlatform: 'linux'
      })
    ).toBe(expected)
  })

  it('preserves paths when the remote platform is unknown', () => {
    expect(
      resolvePaneSpawnReservationPathFlavor({
        connectionId: 'ssh-unknown',
        executionRuntime: 'ssh',
        localPlatform: 'win32'
      })
    ).toBe('unknown')
  })
})
