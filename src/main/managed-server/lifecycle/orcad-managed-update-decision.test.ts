import { describe, expect, it } from 'vitest'
import { managedUpdateForce } from './orcad-managed-update-decision'

describe('managedUpdateForce', () => {
  it('gives full force, which can end uncounted terminals, only to a caller that confirmed it', () => {
    expect(managedUpdateForce({ force: true })).toBe('live-terminals')
    expect(managedUpdateForce({ force: true, endServerTerminals: true })).toBe(true)
    expect(managedUpdateForce({ endServerTerminals: true })).toBeUndefined()
    const incumbentVersion = '0.2.0'
    expect(managedUpdateForce({ pastLiveTerminals: { incumbentVersion } })).toBe('live-terminals')
    expect(managedUpdateForce({ pastLiveTerminals: { incumbentVersion, uncounted: true } })).toBe(
      true
    )
  })
})
