import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrcaCloudSignInEnd, OrcaCloudSignInProgress } from '../../shared/orca-profiles'
import {
  cancelOrcaCloudSignIn,
  endOrcaCloudSignInProgress,
  getOrcaCloudSignInProgress,
  onOrcaCloudSignInProgressChanged,
  resetOrcaCloudSignInProgressForTests,
  setOrcaCloudSignInLink,
  startOrcaCloudSignInProgress
} from './profile-cloud-sign-in-progress'

afterEach(() => resetOrcaCloudSignInProgressForTests())

function record(): [OrcaCloudSignInProgress | null, OrcaCloudSignInEnd | undefined][] {
  const events: [OrcaCloudSignInProgress | null, OrcaCloudSignInEnd | undefined][] = []
  onOrcaCloudSignInProgressChanged((progress, end) => events.push([progress, end]))
  return events
}

describe('Orca Cloud sign-in progress', () => {
  it('Cancel aborts the pending attempt and clears progress at once', () => {
    const events = record()
    const abort = vi.fn()
    startOrcaCloudSignInProgress(1, abort)
    setOrcaCloudSignInLink(1, 'https://auth.test/authorize')
    cancelOrcaCloudSignIn()
    expect(abort).toHaveBeenCalledOnce()
    expect(getOrcaCloudSignInProgress()).toBeNull()
    expect(events.at(-1)).toEqual([null, undefined])
    // The aborted attempt ending later changes nothing.
    endOrcaCloudSignInProgress(1)
    expect(events).toHaveLength(3)
  })

  it('clears progress even when aborting throws', () => {
    startOrcaCloudSignInProgress(1, () => {
      throw new Error('already closed')
    })
    expect(() => cancelOrcaCloudSignIn()).not.toThrow()
    expect(getOrcaCloudSignInProgress()).toBeNull()
  })

  it('a second sign-in replaces the first and cancels it', () => {
    const first = vi.fn()
    const second = vi.fn()
    startOrcaCloudSignInProgress(1, first)
    setOrcaCloudSignInLink(1, 'https://auth.test/one')
    startOrcaCloudSignInProgress(2, second)
    expect(first).toHaveBeenCalledOnce()
    expect(second).not.toHaveBeenCalled()
    expect(getOrcaCloudSignInProgress()).toEqual({ link: null })
    // The replaced attempt can neither set its link nor end the newer one.
    setOrcaCloudSignInLink(1, 'https://auth.test/stale')
    endOrcaCloudSignInProgress(1)
    expect(getOrcaCloudSignInProgress()).toEqual({ link: null })
    setOrcaCloudSignInLink(2, 'https://auth.test/two')
    expect(getOrcaCloudSignInProgress()).toEqual({ link: 'https://auth.test/two' })
  })

  it('says when a sign-in timed out', () => {
    const events = record()
    startOrcaCloudSignInProgress(3, vi.fn())
    endOrcaCloudSignInProgress(3, 'timed-out')
    expect(events.at(-1)).toEqual([null, 'timed-out'])
  })

  it('Cancel with nothing pending is a no-op', () => {
    const events = record()
    cancelOrcaCloudSignIn()
    expect(events).toHaveLength(0)
  })
})
