import { describe, expect, it } from 'vitest'

import { evaluateOrcadActivation } from './orcad-activation-gate'
import type { ServeReadiness } from '../server/serve-readiness'
import type { OrcadHealth, TerminalDaemonHealth } from '../orcad/orcad-health'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../shared/pairing'

const EXPECTED = {
  buildHash: 'abc123def4567890',
  fullVersion: '0.2.0+bb01',
  runtimeKind: 'bun' as const,
  buildTarget: 'linux-x64-glibc' as const,
  port: 7777
}
const PAIRING_ENDPOINT = 'ws://127.0.0.1:7777'

function pairing(): Extract<ServeReadiness['pairing'], { available: true }> {
  return {
    available: true,
    url: encodePairingOffer({
      v: PAIRING_OFFER_VERSION,
      endpoint: PAIRING_ENDPOINT,
      deviceToken: 'device-token',
      publicKeyB64: 'public-key',
      pairedDeviceId: 'device-1',
      scope: 'runtime'
    }),
    endpoint: PAIRING_ENDPOINT,
    deviceId: 'device-1',
    webClientUrl: null,
    scope: 'runtime',
    qr: null
  }
}

function daemon(overrides: Partial<TerminalDaemonHealth> = {}): TerminalDaemonHealth {
  return {
    state: 'live',
    ownsFreshSessions: true,
    pid: 4242,
    buildVersion: '0.2.0+bb01',
    entryPath: '/home/u/.orca-remote/orcad-0.2.0+bb01/daemon-entry.js',
    protocolVersion: 3,
    selfTest: { ok: true, coverage: 'pty-spawn', verdict: 'healthy', durationMs: 12 },
    ...overrides
  }
}

function health(overrides: Partial<OrcadHealth> = {}): OrcadHealth {
  return {
    buildHash: EXPECTED.buildHash,
    buildVersion: EXPECTED.fullVersion,
    nodeVersion: '20.11.0',
    nodeAbi: '115',
    runtimeKind: 'bun',
    runtimeVersion: '1.4.0',
    ptyBackend: 'bun-terminal',
    buildTarget: 'linux-x64-glibc',
    libc: 'glibc',
    platform: 'linux',
    arch: 'x64',
    pid: 4200,
    terminalDaemon: daemon(),
    ...overrides
  }
}

function readiness(overrides: Partial<ServeReadiness> = {}): ServeReadiness {
  return {
    runtimeId: 'runtime-1',
    boundEndpoint: 'ws://127.0.0.1:7777',
    advertisedEndpoint: null,
    managedWslCliReconciliation: 'settled',
    pairing: pairing(),
    health: health(),
    ...overrides
  }
}

describe('evaluateOrcadActivation', () => {
  it('activates a candidate that proved a real PTY round trip', () => {
    const verdict = evaluateOrcadActivation(readiness(), EXPECTED)
    expect(verdict).toEqual({ decision: 'activate', coverage: 'pty-spawn', warnings: [] })
  })

  it('requires the daemon runtime proof for a new Bun activation', () => {
    const verdict = evaluateOrcadActivation(readiness(), {
      ...EXPECTED,
      requireDaemonRuntimeIdentity: true
    })
    expect(verdict).toMatchObject({
      decision: 'reject',
      code: 'orcad_activation_daemon_runtime_mismatch'
    })
  })

  it('accepts a Bun activation when the daemon proves Bun PTYs', () => {
    const verdict = evaluateOrcadActivation(
      readiness({
        health: health({
          terminalDaemon: daemon({
            runtimeKind: 'bun',
            runtimeVersion: '1.4.0',
            ptyBackend: 'bun-terminal'
          })
        })
      }),
      { ...EXPECTED, requireDaemonRuntimeIdentity: true }
    )
    expect(verdict).toEqual({ decision: 'activate', coverage: 'pty-spawn', warnings: [] })
  })

  it('rejects a Bun daemon that falls back to node-pty', () => {
    const verdict = evaluateOrcadActivation(
      readiness({
        health: health({
          terminalDaemon: daemon({ runtimeKind: 'bun', ptyBackend: 'node-pty' })
        })
      }),
      { ...EXPECTED, requireDaemonRuntimeIdentity: true }
    )
    expect(verdict).toMatchObject({
      decision: 'reject',
      code: 'orcad_activation_daemon_pty_backend_mismatch'
    })
  })

  it('refuses when the candidate never published readiness', () => {
    const verdict = evaluateOrcadActivation(null, EXPECTED)
    expect(verdict).toMatchObject({ decision: 'reject', code: 'orcad_activation_no_readiness' })
  })

  it('refuses a readiness payload with no health, rather than reading silence as healthy', () => {
    const { health: _dropped, ...withoutHealth } = readiness()
    const verdict = evaluateOrcadActivation(withoutHealth as ServeReadiness, EXPECTED)
    expect(verdict).toMatchObject({ decision: 'reject', code: 'orcad_activation_no_health' })
  })

  it('refuses when a different build answered — a stale process holding the port', () => {
    const verdict = evaluateOrcadActivation(
      readiness({ health: health({ buildHash: '0000000000000000' }) }),
      EXPECTED
    )
    expect(verdict).toMatchObject({ decision: 'reject', code: 'orcad_activation_build_mismatch' })
  })

  it('refuses when the candidate omits its native build target', () => {
    const verdict = evaluateOrcadActivation(
      readiness({ health: health({ buildTarget: undefined }) }),
      EXPECTED
    )
    expect(verdict).toMatchObject({
      decision: 'reject',
      code: 'orcad_activation_build_target_mismatch'
    })
  })

  it('refuses a glibc candidate running on a musl host', () => {
    const verdict = evaluateOrcadActivation(
      readiness({ health: health({ libc: 'musl' }) }),
      EXPECTED
    )
    expect(verdict).toMatchObject({
      decision: 'reject',
      code: 'orcad_activation_build_target_mismatch'
    })
  })

  it('refuses a listening orcad whose terminal daemon is absent', () => {
    const verdict = evaluateOrcadActivation(
      readiness({
        health: health({
          terminalDaemon: daemon({
            state: 'absent',
            ownsFreshSessions: false,
            selfTest: { ok: false, coverage: 'pty-spawn', verdict: 'no-daemon', durationMs: 1 }
          })
        })
      }),
      EXPECTED
    )
    expect(verdict).toMatchObject({ decision: 'reject', code: 'orcad_activation_daemon_absent' })
  })

  it('refuses a degraded daemon, whose fresh terminals would not survive a restart', () => {
    const verdict = evaluateOrcadActivation(
      readiness({
        health: health({ terminalDaemon: daemon({ state: 'degraded', ownsFreshSessions: false }) })
      }),
      EXPECTED
    )
    expect(verdict).toMatchObject({ decision: 'reject', code: 'orcad_activation_daemon_degraded' })
  })

  it('refuses a live daemon that failed its PTY spawn probe', () => {
    const verdict = evaluateOrcadActivation(
      readiness({
        health: health({
          terminalDaemon: daemon({
            selfTest: {
              ok: false,
              coverage: 'pty-spawn',
              verdict: 'pty-spawn-unhealthy',
              durationMs: 30
            }
          })
        })
      }),
      EXPECTED
    )
    expect(verdict).toMatchObject({
      decision: 'reject',
      code: 'orcad_activation_pty_self_test_failed'
    })
  })

  it('refuses a green daemon that does not own fresh sessions', () => {
    const verdict = evaluateOrcadActivation(
      readiness({ health: health({ terminalDaemon: daemon({ ownsFreshSessions: false }) }) }),
      EXPECTED
    )
    expect(verdict).toMatchObject({
      decision: 'reject',
      code: 'orcad_activation_no_persistent_terminals'
    })
  })

  it('refuses a candidate that is not listening', () => {
    const verdict = evaluateOrcadActivation(readiness({ boundEndpoint: null }), EXPECTED)
    expect(verdict).toMatchObject({ decision: 'reject', code: 'orcad_activation_not_listening' })
  })

  it('refuses a non-loopback bound endpoint', () => {
    const verdict = evaluateOrcadActivation(
      readiness({ boundEndpoint: 'ws://runtime.example.com:7777' }),
      EXPECTED
    )
    expect(verdict).toMatchObject({ decision: 'reject', code: 'orcad_activation_not_listening' })
  })

  it('refuses an OS-assigned fallback port that the managed tunnel will not dial', () => {
    const verdict = evaluateOrcadActivation(
      readiness({ boundEndpoint: 'ws://127.0.0.1:8888' }),
      EXPECTED
    )
    expect(verdict).toMatchObject({ decision: 'reject', code: 'orcad_activation_not_listening' })
  })

  it('refuses activation without a pairing offer', () => {
    const verdict = evaluateOrcadActivation(
      readiness({
        pairing: {
          available: false,
          reason: 'device_registry_unavailable',
          guidance: 'registry is unavailable'
        }
      }),
      EXPECTED
    )
    expect(verdict).toMatchObject({
      decision: 'reject',
      code: 'orcad_activation_pairing_unavailable'
    })
  })

  it('refuses a pairing offer that escapes the SSH loopback boundary', () => {
    const remoteEndpoint = 'wss://runtime.example.com'
    const verdict = evaluateOrcadActivation(
      readiness({
        pairing: {
          ...pairing(),
          available: true,
          endpoint: remoteEndpoint,
          url: encodePairingOffer({
            v: PAIRING_OFFER_VERSION,
            endpoint: remoteEndpoint,
            deviceToken: 'device-token',
            publicKeyB64: 'public-key',
            pairedDeviceId: 'device-1',
            scope: 'runtime'
          })
        }
      }),
      EXPECTED
    )
    expect(verdict).toMatchObject({
      decision: 'reject',
      code: 'orcad_activation_pairing_invalid'
    })
  })

  it('refuses a candidate launched under Node for a Bun slot', () => {
    const verdict = evaluateOrcadActivation(
      readiness({ health: health({ runtimeKind: 'node', ptyBackend: 'node-pty' }) }),
      EXPECTED
    )
    expect(verdict).toMatchObject({
      decision: 'reject',
      code: 'orcad_activation_runtime_mismatch'
    })
  })

  it('refuses a Bun process that is not using bun-terminal', () => {
    const verdict = evaluateOrcadActivation(
      readiness({ health: health({ ptyBackend: 'node-pty' }) }),
      EXPECTED
    )
    expect(verdict).toMatchObject({
      decision: 'reject',
      code: 'orcad_activation_pty_backend_mismatch'
    })
  })

  it('refuses handshake-only coverage from an adopted legacy Windows daemon', () => {
    const verdict = evaluateOrcadActivation(
      readiness({
        health: health({
          platform: 'win32',
          terminalDaemon: daemon({
            selfTest: { ok: true, coverage: 'handshake', verdict: 'healthy', durationMs: 5 }
          })
        })
      }),
      { ...EXPECTED, buildTarget: undefined }
    )
    expect(verdict).toMatchObject({
      decision: 'reject',
      code: 'orcad_activation_pty_self_test_insufficient'
    })
  })

  it('checks identity before health, so a wrong-build green payload cannot pass', () => {
    const verdict = evaluateOrcadActivation(
      readiness({
        health: health({ buildHash: 'ffffffffffffffff', terminalDaemon: daemon() })
      }),
      EXPECTED
    )
    expect(verdict).toMatchObject({ code: 'orcad_activation_build_mismatch' })
  })
})
