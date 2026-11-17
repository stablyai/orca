import { describe, expect, it } from 'vitest'
import {
  UNOPENED_IDLE_STOP_MS,
  claimQuietWake,
  endQuietWake,
  isQuietWake,
  markQuietWake,
  noteQuietWakeResumed,
  noteQuietWakeWoke,
  takeQuietWakeResumed,
  unopenedIdleStopMs
} from './quiet-wakes'

describe('quiet wakes', () => {
  it('a quiet wake that woke the VM gets the short idle window until opened', () => {
    markQuietWake('ws')
    expect(isQuietWake('ws')).toBe(true)
    noteQuietWakeWoke('ws')
    endQuietWake('ws')
    expect(isQuietWake('ws')).toBe(false)
    expect(unopenedIdleStopMs('ws')).toBe(UNOPENED_IDLE_STOP_MS)
    claimQuietWake('ws')
    expect(unopenedIdleStopMs('ws')).toBeNull()
  })

  it('an open during the quiet wake claims it (its failure is then recorded)', () => {
    markQuietWake('ws2')
    claimQuietWake('ws2')
    expect(isQuietWake('ws2')).toBe(false)
    noteQuietWakeWoke('ws2')
    expect(unopenedIdleStopMs('ws2')).toBeNull()
  })

  it('records whether a quiet wake actually resumed the VM, once', () => {
    markQuietWake('ws3')
    expect(takeQuietWakeResumed('ws3')).toBe(false)
    noteQuietWakeResumed('ws3')
    expect(takeQuietWakeResumed('ws3')).toBe(true)
    expect(takeQuietWakeResumed('ws3')).toBe(false)
    endQuietWake('ws3')
    // An ordinary (not quiet) wake's resume is not recorded.
    noteQuietWakeResumed('ws4')
    expect(takeQuietWakeResumed('ws4')).toBe(false)
  })
})
