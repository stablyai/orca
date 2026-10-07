import { beforeEach, describe, expect, it, vi } from 'vitest'

const runProcessSync = vi.hoisted(() => vi.fn())
vi.mock('../../shared/child-process/run-process', () => ({ runProcessSync }))

const { probeSecretServiceCollection } = await import('./linux-secret-service-probe')

function answers(overrides: Partial<{ code: number | null; stdout: string; timedOut: boolean }>) {
  runProcessSync.mockReturnValue({ code: 0, stdout: '', stderr: '', timedOut: false, ...overrides })
}

describe('probeSecretServiceCollection', () => {
  beforeEach(() => vi.clearAllMocks())

  it('reports unlocked for the gdbus false variant', () => {
    answers({ stdout: '(<false>,)\n' })
    expect(probeSecretServiceCollection()).toBe('unlocked')
  })

  it('reports locked for the gdbus true variant', () => {
    answers({ stdout: '(<true>,)\n' })
    expect(probeSecretServiceCollection()).toBe('locked')
  })

  it('reports unavailable when no name owns org.freedesktop.secrets', () => {
    answers({ code: 1, stdout: '' })
    expect(probeSecretServiceCollection()).toBe('unavailable')
  })

  // Why unavailable and not locked: a timeout means we learned nothing, and guessing
  // "locked" would be the same no-op while implying we measured something.
  it('reports unavailable when the probe is killed on its timeout', () => {
    answers({ code: null, stdout: '', timedOut: true })
    expect(probeSecretServiceCollection()).toBe('unavailable')
  })

  it('reports unavailable when gdbus is not installed', () => {
    runProcessSync.mockImplementation(() => {
      throw Object.assign(new Error('spawnSync gdbus ENOENT'), { code: 'ENOENT' })
    })
    expect(probeSecretServiceCollection()).toBe('unavailable')
  })

  it('reports unavailable for output it does not recognise rather than assuming', () => {
    answers({ stdout: '(<@ms "something else">,)' })
    expect(probeSecretServiceCollection()).toBe('unavailable')
  })

  // The probe exists to be abandonable; a call without a kill deadline could become the
  // 76s stall it is meant to detect.
  it('bounds the child with a timeout and reads a property that cannot prompt', () => {
    answers({ stdout: '(<false>,)' })
    probeSecretServiceCollection()
    const spec = runProcessSync.mock.calls[0]![0]
    expect(spec.timeoutMs).toBeGreaterThan(0)
    expect(spec.program).toBe('gdbus')
    expect(spec.args).toContain('org.freedesktop.DBus.Properties.Get')
    expect(spec.args).toContain('Locked')
    expect(spec.args).not.toContain('Unlock')
  })
})
