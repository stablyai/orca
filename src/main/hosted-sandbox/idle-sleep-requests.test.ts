import { beforeEach, describe, expect, it } from 'vitest'
import {
  IDLE_SLEEP_REQUEST_TTL_MS,
  noteIdleSleepRequested,
  resetIdleSleepRequests,
  takeSuspendReason
} from './idle-sleep-requests'

describe('idle sleep requests', () => {
  beforeEach(() => resetIdleSleepRequests())

  it('marks the suspend that follows an idle request as idle, once', () => {
    noteIdleSleepRequested('sbx_1', 1_000)
    expect(takeSuspendReason('sbx_1', 2_000)).toBe('idle')
    expect(takeSuspendReason('sbx_1', 3_000)).toBe('user')
  })

  it('treats any other suspend as one someone chose', () => {
    noteIdleSleepRequested('sbx_1', 1_000)
    expect(takeSuspendReason('sbx_2', 2_000)).toBe('user')
  })

  it('ignores a stale request', () => {
    noteIdleSleepRequested('sbx_1', 1_000)
    expect(takeSuspendReason('sbx_1', 1_000 + IDLE_SLEEP_REQUEST_TTL_MS + 1)).toBe('user')
  })
})
