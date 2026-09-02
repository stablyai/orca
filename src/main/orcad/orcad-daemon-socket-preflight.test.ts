import { describe, expect, it } from 'vitest'
import {
  assertDaemonSocketPathFits,
  OrcadDaemonSocketPathError
} from './orcad-daemon-socket-preflight'
import { ORCAD_EXIT_CONFIGURATION, resolveOrcadExitCode } from './orcad-entry'

describe('daemon socket path preflight', () => {
  it('accepts an ordinary root', () => {
    expect(() => assertDaemonSocketPathFits('/home/orca/.orca')).not.toThrow()
  })

  it.skipIf(process.platform === 'win32')('refuses a root that cannot host the socket', () => {
    expect(() => assertDaemonSocketPathFits(`/home/${'x'.repeat(120)}/.orca`)).toThrow(
      OrcadDaemonSocketPathError
    )
  })

  it('exits 78 so a supervisor stops instead of restart-spinning', () => {
    // The whole point of refusing here rather than degrading: the generated unit sets
    // RestartPreventExitStatus=78, and no restart will ever shorten the path.
    expect(resolveOrcadExitCode(new OrcadDaemonSocketPathError('too long'))).toBe(
      ORCAD_EXIT_CONFIGURATION
    )
  })
})
