import { describe, expect, it } from 'vitest'
import { getWorktreeCreateTimeoutConfig } from './worktree-create-timeouts'

const TIMEOUT_FLAGS = [
  ['refresh-timeout-ms', 'refreshBaseRefMs'],
  ['add-timeout-ms', 'addCheckoutMs'],
  ['registration-timeout-ms', 'registrationMs'],
  ['materialization-timeout-ms', 'materializationMs']
] as const

const INVALID_TIMEOUTS = ['999', '7200001', '1.5', 'NaN', 'Infinity', true]

describe('worktree create timeout flags', () => {
  it.each(TIMEOUT_FLAGS)('accepts the inclusive bounds for --%s', (flag, timeoutKey) => {
    expect(getWorktreeCreateTimeoutConfig(new Map([[flag, '1000']])).timeouts).toEqual({
      [timeoutKey]: 1_000
    })
    expect(getWorktreeCreateTimeoutConfig(new Map([[flag, '7200000']])).timeouts).toEqual({
      [timeoutKey]: 7_200_000
    })
  })

  it.each(
    TIMEOUT_FLAGS.flatMap(([flag]) => INVALID_TIMEOUTS.map((value) => [flag, value] as const))
  )('rejects invalid --%s value %s', (flag, value) => {
    expect(() => getWorktreeCreateTimeoutConfig(new Map([[flag, value]]))).toThrow(
      `--${flag} must be a finite integer between 1000 and 7200000`
    )
  })

  it('omits the RPC timeout object while allowing the host maximum stage budget', () => {
    expect(getWorktreeCreateTimeoutConfig(new Map())).toEqual({
      transportTimeoutMs: 28_830_000
    })
  })

  it('uses the maximum transport budget when any stage inherits from the host', () => {
    expect(
      getWorktreeCreateTimeoutConfig(
        new Map([
          ['refresh-timeout-ms', '1000'],
          ['materialization-timeout-ms', '4000']
        ])
      )
    ).toEqual({
      timeouts: {
        refreshBaseRefMs: 1_000,
        materializationMs: 4_000
      },
      transportTimeoutMs: 28_830_000
    })
  })

  it('keeps the maximum transport budget when every stage is explicit', () => {
    expect(
      getWorktreeCreateTimeoutConfig(
        new Map([
          ['refresh-timeout-ms', '1000'],
          ['add-timeout-ms', '2000'],
          ['registration-timeout-ms', '3000'],
          ['materialization-timeout-ms', '4000']
        ])
      )
    ).toEqual({
      timeouts: {
        refreshBaseRefMs: 1_000,
        addCheckoutMs: 2_000,
        registrationMs: 3_000,
        materializationMs: 4_000
      },
      transportTimeoutMs: 28_830_000
    })
  })
})
