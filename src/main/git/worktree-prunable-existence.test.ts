import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as FsPromises from 'node:fs/promises'
import type { GitWorktreeInfo } from '../../shared/types'

const statMock = vi.hoisted(() => vi.fn())

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof FsPromises>()),
  stat: statMock
}))

import { annotatePrunableByExistence } from './worktree'

function linkedWorktree(path: string): GitWorktreeInfo {
  return {
    path,
    head: 'abc',
    branch: 'feature',
    isBare: false,
    isMainWorktree: false
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('annotatePrunableByExistence', () => {
  beforeEach(() => {
    statMock.mockReset()
  })

  it('marks ENOTDIR registrations as prunable', async () => {
    statMock.mockRejectedValue(Object.assign(new Error('not a directory'), { code: 'ENOTDIR' }))

    await expect(
      annotatePrunableByExistence([linkedWorktree('/repo/child')], '/repo')
    ).resolves.toEqual([expect.objectContaining({ path: '/repo/child', prunable: true })])
  })

  it('keeps unreadable rows unannotated instead of failing the whole listing', async () => {
    // Why: one TCC/NFS-denied worktree used to reject the scan, erasing every row for the repo.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const held = deferred<void>()
    let inFlight = 0
    let peakInFlight = 0
    statMock.mockImplementation(async (path: string) => {
      inFlight += 1
      peakInFlight = Math.max(peakInFlight, inFlight)
      try {
        if (path.endsWith('/child-0')) {
          throw Object.assign(new Error('denied'), { code: 'EACCES' })
        }
        if (path.endsWith('/child-1')) {
          await held.promise
          return
        }
        throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      } finally {
        inFlight -= 1
      }
    })
    const worktrees = Array.from({ length: 12 }, (_, index) =>
      linkedWorktree(`/repo/child-${index}`)
    )
    const result = annotatePrunableByExistence(worktrees, '/repo')
    held.resolve()
    const annotated = await result

    expect(annotated[0].prunable).toBeUndefined()
    expect(annotated[1].prunable).toBeUndefined()
    expect(annotated.slice(2).every((worktree) => worktree.prunable === true)).toBe(true)
    expect(peakInFlight).toBeLessThanOrEqual(8)
    warn.mockRestore()
  })
})
