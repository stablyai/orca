import { describe, expect, it } from 'vitest'
import { parseEmulatorBiometricRequest } from './emulator-biometric-args'
import { RuntimeClientError } from './runtime-client'

function flags(entries: Record<string, string | boolean>): Map<string, string | boolean> {
  return new Map(Object.entries(entries))
}

function expectInvalidArgument(run: () => unknown, message: string): void {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeClientError)
    expect((error as RuntimeClientError).code).toBe('invalid_argument')
    expect((error as RuntimeClientError).message).toContain(message)
    return
  }
  throw new Error('expected an invalid_argument error')
}

describe('parseEmulatorBiometricRequest', () => {
  it('accepts every action', () => {
    for (const action of ['enroll', 'unenroll', 'match', 'nomatch'] as const) {
      expect(parseEmulatorBiometricRequest(flags({ action }))).toEqual({ action })
    }
  })

  it('rejects an unknown action', () => {
    expectInvalidArgument(
      () => parseEmulatorBiometricRequest(flags({ action: 'scan' })),
      '<action> must be enroll, unenroll, match, or nomatch'
    )
  })

  it('carries an explicit biometry type for match and nomatch', () => {
    expect(parseEmulatorBiometricRequest(flags({ action: 'match', type: 'touch' }))).toEqual({
      action: 'match',
      type: 'touch'
    })
    expect(parseEmulatorBiometricRequest(flags({ action: 'nomatch', type: 'face' }))).toEqual({
      action: 'nomatch',
      type: 'face'
    })
  })

  it('leaves the type unset so the default lives in one place', () => {
    expect(parseEmulatorBiometricRequest(flags({ action: 'match' }))).not.toHaveProperty('type')
  })

  it('rejects --type on enroll and unenroll', () => {
    for (const action of ['enroll', 'unenroll'] as const) {
      expectInvalidArgument(
        () => parseEmulatorBiometricRequest(flags({ action, type: 'touch' })),
        `--type is not accepted for ${action}`
      )
    }
  })

  it('rejects an unknown biometry type', () => {
    expectInvalidArgument(
      () => parseEmulatorBiometricRequest(flags({ action: 'match', type: 'iris' })),
      '--type must be face or touch'
    )
  })
})
