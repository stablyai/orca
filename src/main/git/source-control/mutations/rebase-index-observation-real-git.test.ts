import * as fs from 'node:fs'
import type * as NodeFs from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { continueRebase } from './rebase-continue'
import { getStatus } from '../status/status-read'
import { createConflictingRebaseRepo } from './rebase-real-git.test-fixture'

const reads = vi.hoisted(() => ({ count: 0 }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return {
    ...actual,
    createReadStream: ((...args: Parameters<typeof actual.createReadStream>) => {
      reads.count++
      return actual.createReadStream(...args)
    }) as typeof actual.createReadStream
  }
})

describe('rebase index observation cost', () => {
  const tempPaths: string[] = []

  afterEach(() => {
    for (const path of tempPaths.splice(0)) {
      fs.rmSync(path, { recursive: true, force: true })
    }
  })

  it('reads the index from status only for an empty step, and only when it changed', async () => {
    const { repoPath, git, write } = createConflictingRebaseRepo(tempPaths)
    expect(() => git('rebase', '--apply', 'main')).toThrow()

    // An ordinary paused step: status has no empty-step reader to serve.
    reads.count = 0
    const paused = await getStatus(repoPath, { includeLineStats: false })
    expect(paused.conflictOperation).toBe('rebase')
    expect(paused.rebaseIndexObservation).toBeUndefined()
    expect(reads.count).toBe(0)

    git('checkout', '--ours', 'a.txt')
    git('add', 'a.txt')
    const stop = await continueRebase(repoPath, 'inspect')
    const empty = await continueRebase(repoPath, 'continue', { expected: stop.stop })
    expect(empty.outcome).toBe('empty')

    // Repeated statuses at an unchanged index reuse one read.
    reads.count = 0
    const first = await getStatus(repoPath, { includeLineStats: false })
    const second = await getStatus(repoPath, { includeLineStats: false })
    expect(first.rebaseIndexObservation).toBe(empty.indexObservation)
    expect(second.rebaseIndexObservation).toBe(empty.indexObservation)
    expect(reads.count).toBe(0)

    // Staging rewrites the index, so the next status reads it once more.
    write('a.txt', 'resolved\n')
    git('add', 'a.txt')
    const staged = await getStatus(repoPath, { includeLineStats: false })
    expect(staged.rebaseIndexObservation).toBeTruthy()
    expect(staged.rebaseIndexObservation).not.toBe(empty.indexObservation)
    expect(reads.count).toBe(1)

    // Once the rebase is gone, the empty-step demand goes with it.
    git('rebase', '--abort')
    await getStatus(repoPath, { includeLineStats: false })
    expect(() => git('rebase', '--apply', 'main')).toThrow()
    reads.count = 0
    const restarted = await getStatus(repoPath, { includeLineStats: false })
    expect(restarted.rebaseIndexObservation).toBeUndefined()
    expect(reads.count).toBe(0)
  })
})
