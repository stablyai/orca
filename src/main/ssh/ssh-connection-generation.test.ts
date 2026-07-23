import { afterEach, describe, expect, it } from 'vitest'
import {
  _internals,
  MAX_RETAINED_SSH_CONNECTION_GENERATION_LEASES,
  MAX_SSH_CONNECTION_GENERATION_RETAINED_TARGET_ID_BYTES,
  MAX_SSH_CONNECTION_GENERATION_TARGET_ID_BYTES,
  MAX_TRACKED_SSH_CONNECTION_GENERATIONS,
  advanceSshConnectionGeneration,
  assertSshMutationExpectation,
  getSshConnectionGeneration,
  resetSshConnectionGenerations,
  retainSshConnectionGeneration,
  setSshConnectionGeneration
} from './ssh-connection-generation'

const SESSION_COUNTER_STRIDE = 2 ** 13
const MAX_SESSION_SCOPE = 2 ** 40 - 1

describe('SSH connection generation session scope', () => {
  afterEach(() => resetSshConnectionGenerations())

  it('does not reuse a target token when a restarted HUB reaches the same counter', () => {
    resetSshConnectionGenerations(41)
    const beforeRestartLease = retainSshConnectionGeneration('ssh-a')
    const beforeRestart = getSshConnectionGeneration('ssh-a')

    resetSshConnectionGenerations(42)
    const afterRestartLease = retainSshConnectionGeneration('ssh-a')
    const afterRestart = getSshConnectionGeneration('ssh-a')

    expect(afterRestart).not.toBe(beforeRestart)
    expect(() => assertSshMutationExpectation('ssh-a', 'ssh-a', beforeRestart)).toThrow(
      'SSH connection changed; refresh and try again'
    )
    expect(() => assertSshMutationExpectation('ssh-a', 'ssh-a', afterRestart)).not.toThrow()
    beforeRestartLease.release()
    afterRestartLease.release()
  })

  it('allocates globally unique target tokens within one HUB session', () => {
    resetSshConnectionGenerations(7)
    const first = retainSshConnectionGeneration('ssh-a')
    const second = retainSshConnectionGeneration('ssh-b')

    expect(getSshConnectionGeneration('ssh-a')).not.toBe(getSshConnectionGeneration('ssh-b'))

    first.release()
    second.release()
  })

  it('rejects an SSH execution-host expectation when direct IPC resolves locally', () => {
    expect(() =>
      assertSshMutationExpectation(undefined, undefined, undefined, 'ssh:ssh-a')
    ).toThrow('Workspace host changed; refresh and try again')
  })

  it('rejects a local execution-host expectation when direct IPC resolves through SSH', () => {
    expect(() => assertSshMutationExpectation('ssh-a', 'ssh-a', 0, 'local')).toThrow(
      'Workspace host changed; refresh and try again'
    )
  })

  it('rejects an unretained target even when its expected token equals the session base', () => {
    resetSshConnectionGenerations(7)

    expect(() =>
      assertSshMutationExpectation('ssh-a', 'ssh-a', 7 * SESSION_COUNTER_STRIDE)
    ).toThrow('SSH connection changed; refresh and try again')
  })

  it('rotates allocation scopes without invalidating unrelated retained targets', () => {
    resetSshConnectionGenerations(11)
    const otherLease = retainSshConnectionGeneration('ssh-b')
    const otherTargetGeneration = getSshConnectionGeneration('ssh-b')
    const rotatingLease = retainSshConnectionGeneration('ssh-a')
    setSshConnectionGeneration('ssh-a', 12 * SESSION_COUNTER_STRIDE - 1)

    const rotatedGeneration = advanceSshConnectionGeneration('ssh-a')

    expect(rotatedGeneration).toBe(12 * SESSION_COUNTER_STRIDE + 1)
    expect(getSshConnectionGeneration('ssh-b')).toBe(otherTargetGeneration)
    expect(() =>
      assertSshMutationExpectation('ssh-b', 'ssh-b', otherTargetGeneration)
    ).not.toThrow()
    otherLease.release()
    rotatingLease.release()
  })

  it('wraps the maximum numeric scope without reusing an allocated token', () => {
    resetSshConnectionGenerations(MAX_SESSION_SCOPE)
    const lease = retainSshConnectionGeneration('ssh-a')
    setSshConnectionGeneration('ssh-a', Number.MAX_SAFE_INTEGER)

    const rolledGeneration = advanceSshConnectionGeneration('ssh-a')

    expect(rolledGeneration).toBe(1)
    expect(Number.isSafeInteger(rolledGeneration)).toBe(true)
    expect(() => assertSshMutationExpectation('ssh-a', 'ssh-a', rolledGeneration!)).not.toThrow()
    lease.release()
  })

  it('rejects only the 4,097th target without changing active or in-flight tokens', () => {
    resetSshConnectionGenerations(7)
    const leases = Array.from({ length: MAX_TRACKED_SSH_CONNECTION_GENERATIONS }, (_, index) =>
      retainSshConnectionGeneration(`ssh-${index}`)
    )
    const activeGeneration = getSshConnectionGeneration('ssh-0')
    const inFlightGeneration = getSshConnectionGeneration(
      `ssh-${MAX_TRACKED_SSH_CONNECTION_GENERATIONS - 1}`
    )

    expect(() => retainSshConnectionGeneration('ssh-overflow')).toThrow(
      'SSH connection generation target capacity exhausted'
    )
    expect(getSshConnectionGeneration('ssh-0')).toBe(activeGeneration)
    expect(getSshConnectionGeneration(`ssh-${MAX_TRACKED_SSH_CONNECTION_GENERATIONS - 1}`)).toBe(
      inFlightGeneration
    )
    expect(() => assertSshMutationExpectation('ssh-0', 'ssh-0', activeGeneration)).not.toThrow()

    leases[1].release()
    const overflowLease = retainSshConnectionGeneration('ssh-overflow')
    expect(getSshConnectionGeneration('ssh-0')).toBe(activeGeneration)
    for (const lease of leases) {
      lease.release()
    }
    overflowLease.release()
    expect(_internals.evidenceForTest()).toEqual({
      retainedGenerationLeases: 0,
      retainedTargetIdBytes: 0,
      trackedTargets: 0
    })
  })

  it('keeps an entry until its final ownership lease releases', () => {
    const activeLease = retainSshConnectionGeneration('ssh-a')
    const inFlightLease = retainSshConnectionGeneration('ssh-a')
    const generation = getSshConnectionGeneration('ssh-a')

    activeLease.release()
    expect(() => assertSshMutationExpectation('ssh-a', 'ssh-a', generation)).not.toThrow()

    inFlightLease.release()
    expect(() => assertSshMutationExpectation('ssh-a', 'ssh-a', generation)).toThrow(
      'SSH connection changed; refresh and try again'
    )
  })

  it('never reuses a released target token during sequential churn', () => {
    let previous = 0
    for (let index = 0; index < 10_000; index += 1) {
      const lease = retainSshConnectionGeneration(`ssh-${index}`)
      const generation = getSshConnectionGeneration(`ssh-${index}`)
      expect(generation).toBeGreaterThan(previous)
      previous = generation
      lease.release()
    }

    expect(_internals.evidenceForTest()).toEqual({
      retainedGenerationLeases: 0,
      retainedTargetIdBytes: 0,
      trackedTargets: 0
    })
  })

  it('bounds outstanding leases for one hung target', () => {
    const leases = Array.from({ length: MAX_RETAINED_SSH_CONNECTION_GENERATION_LEASES }, () =>
      retainSshConnectionGeneration('ssh-a')
    )
    const generation = getSshConnectionGeneration('ssh-a')

    expect(() => retainSshConnectionGeneration('ssh-a')).toThrow(
      'SSH connection generation lease capacity exhausted'
    )
    expect(getSshConnectionGeneration('ssh-a')).toBe(generation)
    expect(() => assertSshMutationExpectation('ssh-a', 'ssh-a', generation)).not.toThrow()
    expect(_internals.evidenceForTest()).toEqual({
      retainedGenerationLeases: MAX_RETAINED_SSH_CONNECTION_GENERATION_LEASES,
      retainedTargetIdBytes: 5,
      trackedTargets: 1
    })

    for (const lease of leases) {
      lease.release()
    }
    expect(_internals.evidenceForTest()).toEqual({
      retainedGenerationLeases: 0,
      retainedTargetIdBytes: 0,
      trackedTargets: 0
    })
  })

  it('bounds individual and aggregate retained target-id bytes', () => {
    expect(() =>
      retainSshConnectionGeneration('x'.repeat(MAX_SSH_CONNECTION_GENERATION_TARGET_ID_BYTES + 1))
    ).toThrow('SSH connection generation target id exceeds')

    const leases = Array.from(
      {
        length:
          MAX_SSH_CONNECTION_GENERATION_RETAINED_TARGET_ID_BYTES /
          MAX_SSH_CONNECTION_GENERATION_TARGET_ID_BYTES
      },
      (_, index) => {
        const prefix = `${index}:`
        return retainSshConnectionGeneration(
          prefix + 'x'.repeat(MAX_SSH_CONNECTION_GENERATION_TARGET_ID_BYTES - prefix.length)
        )
      }
    )
    expect(() => retainSshConnectionGeneration('overflow')).toThrow(
      'SSH connection generation target capacity exhausted'
    )

    for (const lease of leases) {
      lease.release()
    }
    expect(_internals.evidenceForTest()).toEqual({
      retainedGenerationLeases: 0,
      retainedTargetIdBytes: 0,
      trackedTargets: 0
    })
  })
})
