import { describe, expect, it, vi, beforeEach } from 'vitest'

const { canonicalizeAccessibleDirectoryMock } = vi.hoisted(() => ({
  canonicalizeAccessibleDirectoryMock: vi.fn()
}))

vi.mock('../ipc/floating-workspace-directory', () => ({
  canonicalizeAccessibleDirectory: canonicalizeAccessibleDirectoryMock
}))

import { resolveWorkspaceTrustForPath } from './workspace-trust-path-canonicalization'
import type { WorkspaceTrustEntry } from '../../shared/workspace-trust-types'

function makeEntry(path: string, trusted: boolean): WorkspaceTrustEntry {
  return { id: 'entry-1', path, trusted, decidedAt: 1, origin: 'intake' }
}

describe('resolveWorkspaceTrustForPath realpath I/O', () => {
  beforeEach(() => {
    canonicalizeAccessibleDirectoryMock.mockReset()
  })

  it('never calls realpath canonicalization for a path with no trusted match', async () => {
    const trusted = await resolveWorkspaceTrustForPath('/home/user/other', [
      makeEntry('/home/user/work', false)
    ])

    expect(trusted).toBe(false)
    expect(canonicalizeAccessibleDirectoryMock).not.toHaveBeenCalled()
  })

  // Why no memoization: a remembered realpath keeps authorizing a symlink that has
  // since been retargeted outside the trusted root, which is the case phase 2 exists
  // to catch. Each query must pay its own two syscalls.
  it('re-canonicalizes both paths on every query rather than reusing an earlier answer', async () => {
    canonicalizeAccessibleDirectoryMock.mockImplementation((p: string) => Promise.resolve(p))
    const entries = [makeEntry('/home/user/work', true)]

    await resolveWorkspaceTrustForPath('/home/user/work/proj', entries)
    await resolveWorkspaceTrustForPath('/home/user/work/proj', entries)

    // Two per query: the query path and the entry path.
    expect(canonicalizeAccessibleDirectoryMock).toHaveBeenCalledTimes(4)
  })
})
