import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eventSchemas } from '../../shared/telemetry-event-registry'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))

const { track } = await import('../telemetry/client')
const { hostServerFailure, hostServerRefusal, trackSshHostServerEvent } =
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

  it('never throws into a connect when tracking fails', () => {
    vi.mocked(track).mockImplementation(() => {
      throw new Error('invalid')
    })
    trackSshHostServerEvent({ kind: 'conversion', phase: 'started' }, null)
    expect(track).toHaveBeenCalledTimes(1)
  })
})
