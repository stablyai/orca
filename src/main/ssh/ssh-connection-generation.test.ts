import { afterEach, describe, expect, it } from 'vitest'
import {
  advanceSshConnectionGeneration,
  assertSshMutationExpectation,
  getSshConnectionGeneration,
  resetSshConnectionGenerations,
  setSshConnectionGeneration
} from './ssh-connection-generation'

const SESSION_COUNTER_STRIDE = 2 ** 13
const MAX_SESSION_SCOPE = 2 ** 40 - 1

describe('SSH connection generation session scope', () => {
  afterEach(() => resetSshConnectionGenerations())

  it('does not reuse a target token when a restarted HUB reaches the same counter', () => {
    resetSshConnectionGenerations(41)
    const beforeRestart = advanceSshConnectionGeneration('ssh-a')

    resetSshConnectionGenerations(42)
    const afterRestart = advanceSshConnectionGeneration('ssh-a')

    expect(afterRestart).not.toBe(beforeRestart)
    expect(() => assertSshMutationExpectation('ssh-a', 'ssh-a', beforeRestart)).toThrow(
      'SSH connection changed; refresh and try again'
    )
    expect(() => assertSshMutationExpectation('ssh-a', 'ssh-a', afterRestart)).not.toThrow()
  })

  it('keeps target counters independent within one HUB session', () => {
    resetSshConnectionGenerations(7)

    expect(advanceSshConnectionGeneration('ssh-a')).toBe(advanceSshConnectionGeneration('ssh-b'))
    expect(getSshConnectionGeneration('ssh-a')).toBe(getSshConnectionGeneration('ssh-b'))
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

  it('rolls the session scope after counter exhaustion and keeps rotating', () => {
    resetSshConnectionGenerations(7)
    const exhaustedGeneration = 8 * SESSION_COUNTER_STRIDE - 1
    setSshConnectionGeneration('ssh-a', exhaustedGeneration)

    const rolledGeneration = advanceSshConnectionGeneration('ssh-a')

    expect(rolledGeneration).toBe(8 * SESSION_COUNTER_STRIDE + 1)
    expect(advanceSshConnectionGeneration('ssh-a')).toBe(rolledGeneration + 1)
    expect(() => assertSshMutationExpectation('ssh-a', 'ssh-a', exhaustedGeneration)).toThrow(
      'SSH connection changed; refresh and try again'
    )
  })

  it('invalidates other targets when exhaustion rolls the session scope', () => {
    resetSshConnectionGenerations(11)
    const otherTargetGeneration = advanceSshConnectionGeneration('ssh-b')
    setSshConnectionGeneration('ssh-a', 12 * SESSION_COUNTER_STRIDE - 1)

    const rolledGeneration = advanceSshConnectionGeneration('ssh-a')

    expect(getSshConnectionGeneration('ssh-b')).toBe(12 * SESSION_COUNTER_STRIDE)
    expect(rolledGeneration).toBe(12 * SESSION_COUNTER_STRIDE + 1)
    expect(() => assertSshMutationExpectation('ssh-b', 'ssh-b', otherTargetGeneration)).toThrow(
      'SSH connection changed; refresh and try again'
    )
    expect(() => assertSshMutationExpectation('ssh-a', 'ssh-a', rolledGeneration)).not.toThrow()
  })

  it('wraps the maximum safe numeric scope without reusing it', () => {
    resetSshConnectionGenerations(MAX_SESSION_SCOPE)
    setSshConnectionGeneration('ssh-a', Number.MAX_SAFE_INTEGER)

    const rolledGeneration = advanceSshConnectionGeneration('ssh-a')

    expect(rolledGeneration).toBe(1)
    expect(Number.isSafeInteger(rolledGeneration)).toBe(true)
    expect(() => assertSshMutationExpectation('ssh-a', 'ssh-a', Number.MAX_SAFE_INTEGER)).toThrow(
      'SSH connection changed; refresh and try again'
    )
  })
})
