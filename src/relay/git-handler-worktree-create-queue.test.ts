import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { GitExec } from './git-handler-ops'
import { addWorktreeOp } from './git-handler-worktree-ops'

const REPO = '/relay-repo'
const BRANCH = 'queue/feature'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

describe('relay worktree create queue', () => {
  it('settles aborted and expired waiters before their predecessor releases', async () => {
    const releaseAdd = deferred()
    let addCalls = 0
    const git = vi.fn<GitExec>(async (args) => {
      if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') {
        return { stdout: `${join(REPO, '.git')}\n`, stderr: '' }
      }
      if (args[0] === 'worktree' && args[1] === 'add') {
        addCalls += 1
        await releaseAdd.promise
      }
      return { stdout: '', stderr: '' }
    })
    const first = addWorktreeOp(git, {
      repoPath: REPO,
      branchName: BRANCH,
      targetDir: '/relay-target-one',
      timeoutMs: 5_000
    })
    await vi.waitFor(() => expect(addCalls).toBe(1))
    const controller = new AbortController()
    const aborted = addWorktreeOp(
      git,
      {
        repoPath: REPO,
        branchName: BRANCH,
        targetDir: '/relay-target-two',
        timeoutMs: 1_000
      },
      { signal: controller.signal }
    )
    const expired = addWorktreeOp(git, {
      repoPath: REPO,
      branchName: BRANCH,
      targetDir: '/relay-target-three',
      timeoutMs: 50
    })
    const abortedResult = expect(aborted).rejects.toMatchObject({ name: 'AbortError' })
    const expiredResult = expect(expired).rejects.toThrow('timed out during lock queue')

    controller.abort()

    await abortedResult
    await expiredResult
    expect(addCalls).toBe(1)
    releaseAdd.resolve()
    await first
  })
})
