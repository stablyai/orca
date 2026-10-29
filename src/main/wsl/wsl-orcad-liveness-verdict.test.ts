import { describe, expect, it } from 'vitest'
import {
  classifyWslOrcadLiveness,
  nextWslLivenessProbe,
  type WslLivenessEvidence
} from './wsl-orcad-liveness-verdict'

const INSTANCE = 'boot-a:100'
const ORCAD = '321:5000'

function evidence(overrides: Partial<WslLivenessEvidence> = {}): WslLivenessEvidence {
  return {
    trigger: { source: 'bridge', code: 1 },
    running: { status: 'confirmed', running: true },
    expected: { distroInstance: INSTANCE, orcad: ORCAD },
    ...overrides
  }
}

describe('classifyWslOrcadLiveness', () => {
  it('reads a failed running-list probe as unverifiable, never exited, whatever the exit code', () => {
    for (const code of [0, 1, null]) {
      const verdict = classifyWslOrcadLiveness(
        evidence({ trigger: { source: 'bridge', code }, running: { status: 'unavailable' } })
      )
      expect(verdict).toEqual({ kind: 'unverifiable', reason: 'running-list-unavailable' })
    }
  })

  it('marks every terminal exited when the distro is confirmed stopped', () => {
    const verdict = classifyWslOrcadLiveness(
      evidence({ running: { status: 'confirmed', running: false } })
    )
    expect(verdict).toEqual({ kind: 'distro-stopped', corroborated: true })
  })

  it('needs no exit code to prove a stop, but only a failed exit corroborates it', () => {
    const stopped = { status: 'confirmed', running: false } as const
    expect(
      classifyWslOrcadLiveness(evidence({ trigger: { source: 'verify' }, running: stopped }))
    ).toEqual({ kind: 'distro-stopped', corroborated: false })
    expect(
      classifyWslOrcadLiveness(
        evidence({ trigger: { source: 'holder', code: 0 }, running: stopped })
      )
    ).toEqual({ kind: 'distro-stopped', corroborated: false })
  })

  it('treats a running distro whose guest did not answer as unverifiable', () => {
    expect(classifyWslOrcadLiveness(evidence({ identity: null }))).toEqual({
      kind: 'unverifiable',
      reason: 'guest-unanswered'
    })
  })

  it('proves a restart from a new boot id or pid 1 start time, without any wall clock', () => {
    const verdict = classifyWslOrcadLiveness(
      evidence({ identity: { distroInstance: 'boot-a:900', orcad: null } })
    )
    expect(verdict).toEqual({ kind: 'distro-restarted' })
  })

  it('reads a gone or reused orcad pid in the same incarnation as orcad exited', () => {
    for (const orcad of [null, '321:7777']) {
      const verdict = classifyWslOrcadLiveness(
        evidence({
          trigger: { source: 'bridge', code: 0 },
          identity: { distroInstance: INSTANCE, orcad }
        })
      )
      expect(verdict).toEqual({ kind: 'orcad-exited' })
    }
  })

  it('keeps orcad live when the same process still runs, even after a bridge exit', () => {
    expect(
      classifyWslOrcadLiveness(
        evidence({
          trigger: { source: 'bridge', code: 0 },
          identity: { distroInstance: INSTANCE, orcad: ORCAD }
        })
      )
    ).toEqual({ kind: 'live' })
  })

  it('falls back to the port when no orcad pid was known', () => {
    const base = evidence({
      expected: { distroInstance: INSTANCE, orcad: null },
      identity: { distroInstance: INSTANCE, orcad: null }
    })
    expect(classifyWslOrcadLiveness({ ...base, orcadPort: 'ready' })).toEqual({ kind: 'live' })
    expect(classifyWslOrcadLiveness({ ...base, orcadPort: 'refused' })).toEqual({
      kind: 'orcad-exited'
    })
    expect(classifyWslOrcadLiveness({ ...base, orcadPort: 'unverifiable' })).toEqual({
      kind: 'unverifiable',
      reason: 'orcad-unanswered'
    })
  })
})

describe('nextWslLivenessProbe', () => {
  it('never probes inside a distro that is not confirmed running (an exec would boot it)', () => {
    expect(nextWslLivenessProbe(evidence({ running: { status: 'unavailable' } }))).toBeNull()
    expect(
      nextWslLivenessProbe(evidence({ running: { status: 'confirmed', running: false } }))
    ).toBeNull()
  })

  it('asks for identity first, and for the port only when no pid identity can decide', () => {
    expect(nextWslLivenessProbe(evidence())).toBe('identity')
    expect(
      nextWslLivenessProbe(evidence({ identity: { distroInstance: INSTANCE, orcad: ORCAD } }))
    ).toBeNull()
    const noPid = evidence({
      expected: { distroInstance: INSTANCE, orcad: null },
      identity: { distroInstance: INSTANCE, orcad: null }
    })
    expect(nextWslLivenessProbe(noPid)).toBe('orcad-port')
    expect(nextWslLivenessProbe({ ...noPid, orcadPort: 'refused' })).toBeNull()
    expect(
      nextWslLivenessProbe({ ...noPid, identity: { distroInstance: 'other', orcad: null } })
    ).toBeNull()
  })
})
