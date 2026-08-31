import { describe, expect, it, vi } from 'vitest'

import { getBranchConflictKindViaExec } from './repo-branch-conflict'

// Enumerate the host-owned conflict policy's remote-list outcome axis: a successful empty list
// is a negative answer, while a failed list must remain distinguishable from that answer.
describe('getBranchConflictKindViaExec remote listing outcomes', () => {
  it('keeps an empty successful remote list distinct from a failed list', async () => {
    const emptyListExec = vi.fn(async (args: string[]) => {
      if (args[0] === 'rev-parse') {
        throw new Error('missing local ref')
      }
      if (args[0] === 'remote') {
        return { stdout: '' }
      }
      if (args[0] === 'for-each-ref') {
        return { stdout: '' }
      }
      throw new Error(`unexpected git ${args.join(' ')}`)
    })

    await expect(
      getBranchConflictKindViaExec(emptyListExec, 'feature/empty', 'origin/main')
    ).resolves.toBeNull()

    const listingFailure = new Error('git remote failed')
    const failedListExec = vi.fn(async (args: string[]) => {
      if (args[0] === 'rev-parse') {
        throw new Error('missing local ref')
      }
      if (args[0] === 'remote') {
        throw listingFailure
      }
      if (args[0] === 'for-each-ref') {
        return { stdout: 'refs/remotes/origin/feature/empty\n' }
      }
      throw new Error(`unexpected git ${args.join(' ')}`)
    })

    await expect(
      getBranchConflictKindViaExec(failedListExec, 'feature/empty', 'origin/main')
    ).rejects.toBe(listingFailure)
  })

  it('does not turn a failed remote-ref listing into a no-conflict answer', async () => {
    const refListingFailure = new Error('git for-each-ref failed')
    const exec = vi.fn(async (args: string[]) => {
      if (args[0] === 'rev-parse') {
        throw new Error('missing local ref')
      }
      if (args[0] === 'remote') {
        return { stdout: 'origin\n' }
      }
      if (args[0] === 'for-each-ref') {
        throw refListingFailure
      }
      throw new Error(`unexpected git ${args.join(' ')}`)
    })

    await expect(getBranchConflictKindViaExec(exec, 'feature/empty', 'origin/main')).rejects.toBe(
      refListingFailure
    )
  })
})
