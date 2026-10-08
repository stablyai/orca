import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eventSchemas } from '../../shared/telemetry-event-registry'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))

const { track } = await import('../telemetry/client')
const { hostServerFailure, hostServerRefusal, trackSshHostServerEvent, trackSshHostServerMove } =
  await import('./ssh-host-server-telemetry')

const linuxGlibc = { os: 'linux', arch: 'x64', libc: 'glibc' } as const

function tracked() {
  const call = vi.mocked(track).mock.calls.at(-1)
  if (!call) {
    throw new Error('nothing was tracked')
  }
  return call
}

function expectSchemaValid(): unknown {
  const [name, props] = tracked()
  expect(eventSchemas[name].safeParse(props).success).toBe(true)
  return props
}

describe('ssh host server telemetry', () => {
  beforeEach(() => {
    vi.mocked(track).mockReset()
  })

  it('maps a decision onto enum-only props the strict schema accepts', () => {
    trackSshHostServerEvent(
      {
        kind: 'decided',
        outcome: 'relay',
        reason: 'refused',
        refusal: 'orcad_migration_preflight_blocked',
        recorded: false,
        durationMs: 7_000
      },
      linuxGlibc
    )
    expect(tracked()[0]).toBe('ssh_host_server_decided')
    expect(expectSchemaValid()).toEqual({
      outcome: 'relay',
      transport: 'none',
      reason: 'refused',
      refusal: 'preflight_blocked',
      recorded: false,
      host_os: 'linux',
      host_arch: 'x64',
      host_libc: 'glibc',
      duration_bucket: '5s_15s'
    })
  })

  it('reports an unprobed host as unknown rather than guessing', () => {
    trackSshHostServerEvent(
      {
        kind: 'decided',
        outcome: 'managed',
        reason: 'connected',
        refusal: null,
        recorded: false,
        durationMs: 10
      },
      null
    )
    expect(expectSchemaValid()).toMatchObject({
      host_os: 'unknown',
      host_arch: 'unknown',
      host_libc: 'unknown'
    })
  })

  it('names the transport a managed connect used, and none for the relay', () => {
    const decision = {
      kind: 'decided',
      outcome: 'managed',
      reason: 'connected',
      refusal: null,
      recorded: false,
      durationMs: 10
    } as const
    trackSshHostServerEvent(decision, linuxGlibc, 'stdio_bridge')
    expect(expectSchemaValid()).toMatchObject({ transport: 'stdio_bridge' })
    trackSshHostServerEvent(decision, linuxGlibc)
    expect(expectSchemaValid()).toMatchObject({ transport: 'unknown' })
    trackSshHostServerEvent(
      { ...decision, outcome: 'relay', reason: 'ssh_tunnel_unavailable' },
      linuxGlibc,
      'tcp_forward'
    )
    expect(expectSchemaValid()).toMatchObject({
      transport: 'none',
      reason: 'ssh_tunnel_unavailable'
    })
  })

  it('keeps every update-on-connect reason through the schema', () => {
    for (const reason of [
      'updated',
      'update_deferred',
      'update_failed',
      'update_host_newer',
      'update_rolled_back',
      'update_check_failed'
    ] as const) {
      trackSshHostServerEvent(
        {
          kind: 'decided',
          outcome: 'managed',
          reason,
          refusal: null,
          recorded: false,
          durationMs: 1
        },
        linuxGlibc,
        'tcp_forward'
      )
      expect(expectSchemaValid()).toMatchObject({ outcome: 'managed', reason })
    }
  })

  it('reports the per-host move offer and each move result', () => {
    for (const outcome of ['offered', 'moved', 'refused_live', 'failed'] as const) {
      trackSshHostServerMove(outcome, linuxGlibc)
      expect(tracked()[0]).toBe('ssh_host_server_move')
      expect(expectSchemaValid()).toEqual({
        outcome,
        host_os: 'linux',
        host_arch: 'x64',
        host_libc: 'glibc'
      })
    }
  })

  it('narrows any unrecognised code, so free text never reaches an event', () => {
    expect(hostServerRefusal('orcad_migration_/home/me/secret')).toBe('other')
    expect(hostServerFailure('Error: ssh me@host.example failed')).toBe('other')
    expect(hostServerFailure('orcad_activation_no_readiness')).toBe('activation_no_readiness')
    expect(hostServerFailure('unsupported_host')).toBe('unsupported_host')

    trackSshHostServerEvent(
      {
        kind: 'decided',
        outcome: 'relay',
        reason: 'host.example.com',
        refusal: null,
        recorded: false,
        durationMs: 0
      },
      linuxGlibc
    )
    expect(expectSchemaValid()).toMatchObject({ reason: 'other' })
  })

  it('maps conversion phases and deploy failures', () => {
    trackSshHostServerEvent({ kind: 'conversion', phase: 'started' }, linuxGlibc)
    expect(expectSchemaValid()).toMatchObject({ phase: 'started', failure: 'none' })

    trackSshHostServerEvent(
      { kind: 'conversion', phase: 'committed', durationMs: 90_000 },
      linuxGlibc
    )
    expect(expectSchemaValid()).toMatchObject({ phase: 'committed', duration_bucket: 'gte_60s' })

    trackSshHostServerEvent(
      {
        kind: 'conversion',
        phase: 'failed',
        failure: 'refused',
        code: 'orcad_migration_terminals',
        durationMs: 100
      },
      linuxGlibc
    )
    expect(expectSchemaValid()).toMatchObject({ refusal: 'terminals', failure_code: 'none' })

    trackSshHostServerEvent(
      {
        kind: 'deploy_failed',
        context: 'deploy',
        failure: 'deferred',
        code: 'orcad_candidate_preflight_failed',
        durationMs: 20_000
      },
      { os: 'linux', arch: 'arm64', libc: 'musl' }
    )
    expect(tracked()[0]).toBe('ssh_host_server_deploy_failed')
    expect(expectSchemaValid()).toEqual({
      context: 'deploy',
      failure: 'deferred',
      failure_code: 'candidate_preflight_failed',
      host_os: 'linux',
      host_arch: 'arm64',
      host_libc: 'musl',
      duration_bucket: '15s_60s'
    })
  })

  it('never throws into a connect when tracking fails', () => {
    vi.mocked(track).mockImplementation(() => {
      throw new Error('invalid')
    })
    trackSshHostServerEvent({ kind: 'conversion', phase: 'started' }, null)
    expect(track).toHaveBeenCalledTimes(1)
  })
})
