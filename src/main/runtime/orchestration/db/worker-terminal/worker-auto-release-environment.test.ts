import { describe, expect, it } from 'vitest'
import {
  readWorkerAutoReleaseEnvironment,
  WORKER_AUTO_RELEASE_ENV,
  WORKER_AUTO_RELEASE_GRACE_ENV
} from './worker-auto-release-environment'

describe('worker auto-release environment', () => {
  it('leaves both to the user setting when nothing is set', () => {
    expect(readWorkerAutoReleaseEnvironment({})).toEqual({ invalid: [] })
    expect(
      readWorkerAutoReleaseEnvironment({
        [WORKER_AUTO_RELEASE_ENV]: ' ',
        [WORKER_AUTO_RELEASE_GRACE_ENV]: ''
      })
    ).toEqual({ invalid: [] })
  })

  it.each([
    ['off', false],
    ['OFF', false],
    [' on ', true]
  ])('reads %j as auto-release %s', (value, enabled) => {
    expect(readWorkerAutoReleaseEnvironment({ [WORKER_AUTO_RELEASE_ENV]: value })).toEqual({
      enabled,
      invalid: []
    })
  })

  it('reads the grace in whole seconds', () => {
    expect(readWorkerAutoReleaseEnvironment({ [WORKER_AUTO_RELEASE_GRACE_ENV]: '600' })).toEqual({
      graceMs: 600_000,
      invalid: []
    })
  })

  it.each(['false', '0', 'disabled'])('ignores the switch value %j and names it', (value) => {
    expect(readWorkerAutoReleaseEnvironment({ [WORKER_AUTO_RELEASE_ENV]: value })).toEqual({
      invalid: [WORKER_AUTO_RELEASE_ENV]
    })
  })

  it.each(['0', '-5', '1.5', '2m', '604801'])('ignores the grace %j and names it', (value) => {
    expect(readWorkerAutoReleaseEnvironment({ [WORKER_AUTO_RELEASE_GRACE_ENV]: value })).toEqual({
      invalid: [WORKER_AUTO_RELEASE_GRACE_ENV]
    })
  })
})
