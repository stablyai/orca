import { describe, expect, it, vi, beforeEach } from 'vitest'

const { canonicalizeAccessibleDirectoryMock } = vi.hoisted(() => ({
  canonicalizeAccessibleDirectoryMock: vi.fn()
}))

vi.mock('../ipc/floating-workspace-directory', () => ({
  canonicalizeAccessibleDirectory: canonicalizeAccessibleDirectoryMock
}))

import {
  invalidateWorkspaceTrustPathCache,
  resolveWorkspaceTrustForPath
} from './workspace-trust-path-canonicalization'
import type { WorkspaceTrustEntry } from '../../shared/workspace-trust-types'

function makeEntry(path: string, trusted: boolean): WorkspaceTrustEntry {
  return { id: 'entry-1', path, trusted, decidedAt: 1, origin: 'intake' }
}

describe('resolveWorkspaceTrustForPath cache behavior', () => {
  beforeEach(() => {
    canonicalizeAccessibleDirectoryMock.mockReset()
    invalidateWorkspaceTrustPathCache()
  })

  it('never calls realpath canonicalization for a path with no trusted match', async () => {
    const trusted = await resolveWorkspaceTrustForPath('/home/user/other', [
      makeEntry('/home/user/work', false)
    ])

    expect(trusted).toBe(false)
    expect(canonicalizeAccessibleDirectoryMock).not.toHaveBeenCalled()
  })

  it('caches a positive canonicalization so a repeated query does not re-invoke realpath', async () => {
    canonicalizeAccessibleDirectoryMock.mockImplementation((p: string) => Promise.resolve(p))
    const entries = [makeEntry('/home/user/work', true)]

    await resolveWorkspaceTrustForPath('/home/user/work/proj', entries)
    await resolveWorkspaceTrustForPath('/home/user/work/proj', entries)

    // Why 2, not 4: each query canonicalizes the query path and the entry path once; the
    // second query hits the warm cache for both, so total calls stay at the first query's count.
    expect(canonicalizeAccessibleDirectoryMock).toHaveBeenCalledTimes(2)
  })

  it('invalidating the cache forces the next query to re-canonicalize', async () => {
    canonicalizeAccessibleDirectoryMock.mockImplementation((p: string) => Promise.resolve(p))
    const entries = [makeEntry('/home/user/work', true)]

    await resolveWorkspaceTrustForPath('/home/user/work/proj', entries)
    invalidateWorkspaceTrustPathCache()
    await resolveWorkspaceTrustForPath('/home/user/work/proj', entries)

    expect(canonicalizeAccessibleDirectoryMock).toHaveBeenCalledTimes(4)
  })
})
