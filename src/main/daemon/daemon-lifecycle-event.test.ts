import { beforeEach, describe, expect, it, vi } from 'vitest'
import { bucketDaemonLiveSessionCount } from '../../shared/daemon-lifecycle-telemetry'
import { validate } from '../telemetry/validator'

const { trackMock } = vi.hoisted(() => ({ trackMock: vi.fn() }))
vi.mock('../telemetry/client', () => ({ track: trackMock }))

import { trackDaemonReplaced, trackDaemonRetired } from './daemon-lifecycle-event'

beforeEach(() => {
  trackMock.mockClear()
})

describe('bucketDaemonLiveSessionCount', () => {
  it('buckets counts and maps null to unknown', () => {
    expect(bucketDaemonLiveSessionCount(null)).toBe('unknown')
    expect(bucketDaemonLiveSessionCount(0)).toBe('0')
    expect(bucketDaemonLiveSessionCount(1)).toBe('1')
    expect(bucketDaemonLiveSessionCount(2)).toBe('2-5')
    expect(bucketDaemonLiveSessionCount(5)).toBe('2-5')
    expect(bucketDaemonLiveSessionCount(6)).toBe('6+')
    expect(bucketDaemonLiveSessionCount(999)).toBe('6+')
  })
})

// Revert-sensitive: asserts each emitter fires `daemon_lifecycle` with a payload the real
// runtime validator accepts. If the event, emitter, or schema is reverted, these fail.
describe('daemon lifecycle emitters', () => {
  it('emits a validator-accepted replace payload', () => {
    trackDaemonReplaced('stale_bundle', 0)
    expect(trackMock).toHaveBeenCalledTimes(1)
    const [name, props] = trackMock.mock.calls[0]
    expect(name).toBe('daemon_lifecycle')
    expect(props).toEqual({
      transition: 'replaced',
      reason: 'stale_bundle',
      live_session_count_bucket: '0'
    })
    expect(validate('daemon_lifecycle', props).ok).toBe(true)
  })

  it('maps an unverifiable session count to the unknown bucket', () => {
    trackDaemonReplaced('different_app_path', null)
    const [, props] = trackMock.mock.calls[0]
    expect(props).toEqual({
      transition: 'replaced',
      reason: 'different_app_path',
      live_session_count_bucket: 'unknown'
    })
    expect(validate('daemon_lifecycle', props).ok).toBe(true)
  })

  // Why: both emitters run on the daemon launch/respawn path, where a throw would cost every terminal.
  it('swallows a throwing telemetry client instead of failing the caller', () => {
    trackMock.mockImplementationOnce(() => {
      throw new Error('posthog exploded')
    })
    expect(() => trackDaemonReplaced('failed_health_check', null)).not.toThrow()
    trackMock.mockImplementationOnce(() => {
      throw new Error('posthog exploded')
    })
    expect(() => trackDaemonRetired('died_respawn')).not.toThrow()
  })

  it('emits a validator-accepted retirement payload', () => {
    trackDaemonRetired('died_respawn')
    const [name, props] = trackMock.mock.calls[0]
    expect(name).toBe('daemon_lifecycle')
    expect(props).toEqual({
      transition: 'retired',
      reason: 'died_respawn',
      live_session_count_bucket: 'unknown'
    })
    expect(validate('daemon_lifecycle', props).ok).toBe(true)
  })
})
