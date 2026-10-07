import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eventSchemas } from '../../shared/telemetry-event-registry'
import { getRemoteHostPlatform } from './ssh-remote-platform'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))

const { track } = await import('../telemetry/client')
const {
  durationBucket,
  glibcMinorBucket,
  resetSshRemoteRuntimeTelemetryForTests,
  sshRemoteRuntimeResolvedProps,
  trackSshRemoteRuntimeResolved
} = await import('./ssh-remote-runtime-telemetry')

const linux = getRemoteHostPlatform('linux-x64')
const base = {
  rung: 'C' as const,
  outcome: 'resolved' as const,
  host: linux,
  facts: { target: 'linux-x64-glibc' as const, glibc: { major: 2, minor: 28 } },
  firstRefusal: 'illegal_instruction',
  selfTest: 'passed' as const,
  runtimeTransfer: 'uploaded' as const,
  hostNode: { major: 18, minor: 19 },
  durationMs: 12_000
}

describe('ssh_remote_runtime_resolved', () => {
  beforeEach(() => {
    vi.mocked(track).mockReset()
    resetSshRemoteRuntimeTelemetryForTests()
  })

  it('maps a rung C connect onto enum-only props the strict schema accepts', () => {
    const props = sshRemoteRuntimeResolvedProps(base)
    expect(props).toEqual({
      rung: 'c',
      host_os: 'linux',
      host_arch: 'x64',
      host_libc: 'glibc',
      glibc_minor: '28',
      first_refusal: 'illegal_instruction',
      self_test: 'passed',
      runtime_transfer: 'uploaded',
      host_node_major: '18',
      duration_bucket: '5s_15s',
      outcome: 'resolved'
    })
    expect(eventSchemas.ssh_remote_runtime_resolved.safeParse(props).success).toBe(true)
  })

  it('rejects any free-form field, so a hostname or path can never ride along', () => {
    const props = { ...sshRemoteRuntimeResolvedProps(base), host: 'build-01.corp' }
    expect(eventSchemas.ssh_remote_runtime_resolved.safeParse(props).success).toBe(false)
  })

  it('buckets glibc minors, durations and unknown refusals', () => {
    expect(glibcMinorBucket(null)).toBe('none')
    expect(glibcMinorBucket({ target: 'linux-x64-glibc', glibc: { major: 2, minor: 12 } })).toBe(
      'below_17'
    )
    expect(glibcMinorBucket({ target: 'linux-x64-glibc', glibc: { major: 2, minor: 50 } })).toBe(
      'above_42'
    )
    expect(durationBucket(1_000)).toBe('lt_5s')
    expect(durationBucket(90_000)).toBe('gte_60s')
    expect(
      sshRemoteRuntimeResolvedProps({ ...base, rung: 'A', firstRefusal: 'from-a-newer-build' })
    ).toMatchObject({ rung: 'a', first_refusal: 'none' })
    expect(
      sshRemoteRuntimeResolvedProps({ ...base, rung: 'A', hostNode: null })
    ).not.toHaveProperty('host_node_major')
  })

  it('names an antivirus refusal and an unverifiable self-test instead of dropping them', () => {
    const props = sshRemoteRuntimeResolvedProps({
      ...base,
      rung: 'A',
      host: getRemoteHostPlatform('win32-x64'),
      facts: null,
      firstRefusal: 'security_software',
      selfTest: 'unverifiable',
      outcome: 'unverifiable',
      hostNode: null
    })
    expect(props).toMatchObject({
      first_refusal: 'security_software',
      self_test: 'unverifiable',
      outcome: 'unverifiable'
    })
    expect(eventSchemas.ssh_remote_runtime_resolved.safeParse(props).success).toBe(true)
  })

  it('reports an unverifiable attempt without using up the later resolved report', () => {
    trackSshRemoteRuntimeResolved('target-1', { ...base, outcome: 'unverifiable' })
    trackSshRemoteRuntimeResolved('target-1', { ...base, outcome: 'unverifiable' })
    trackSshRemoteRuntimeResolved('target-1', base)
    expect(vi.mocked(track).mock.calls.map(([, props]) => JSON.stringify(props))).toEqual([
      JSON.stringify(sshRemoteRuntimeResolvedProps({ ...base, outcome: 'unverifiable' })),
      JSON.stringify(sshRemoteRuntimeResolvedProps(base))
    ])
  })

  it('reports each host once per app session', () => {
    trackSshRemoteRuntimeResolved('target-1', base)
    trackSshRemoteRuntimeResolved('target-1', { ...base, rung: 'D' })
    trackSshRemoteRuntimeResolved('target-2', base)
    expect(track).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(vi.mocked(track).mock.calls)).not.toContain('target-')
  })
})
