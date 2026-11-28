import { describe, expect, it } from 'vitest'
import { claimMobileFileSearch } from './files-mobile-search-supersession'

describe('claimMobileFileSearch', () => {
  it("keeps one search per phone: a newer one ends the older, and the older's release keeps the newer", () => {
    const first = claimMobileFileSearch('device-a', undefined)!
    const other = claimMobileFileSearch('device-b', undefined)!
    const second = claimMobileFileSearch('device-a', undefined)!
    expect(first.signal.aborted).toBe(true)
    expect(other.signal.aborted).toBe(false)
    first.release()
    const third = claimMobileFileSearch('device-a', undefined)!
    expect(second.signal.aborted).toBe(true)
    expect(third.signal.aborted).toBe(false)
    const closing = new AbortController()
    const fourth = claimMobileFileSearch('device-b', closing.signal)!
    closing.abort()
    expect(fourth.signal.aborted).toBe(true)
    for (const claim of [other, second, third, fourth]) {
      claim.release()
    }
    expect(claimMobileFileSearch(undefined, undefined)).toBeNull()
  })
})
