import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { createConflictingRebaseRepo } from '../source-control/mutations/rebase-real-git.test-fixture'
import { headMovedOnlyByRebaseRun } from './orca-rebase-reflog'

describe('headMovedOnlyByRebaseRun against real git', () => {
  const tempPaths: string[] = []
  const ACTION = 'rebase (orca 1234abcd)'

  afterEach(() => {
    for (const path of tempPaths.splice(0)) {
      rmSync(path, { recursive: true, force: true })
    }
  })

  function pausedRun(reflogAction: string) {
    const repo = createConflictingRebaseRepo(tempPaths)
    expect(() =>
      execFileSync('git', ['rebase', 'main'], {
        cwd: repo.repoPath,
        env: { ...process.env, GIT_REFLOG_ACTION: reflogAction, HOME: repo.repoPath },
        stdio: 'ignore'
      })
    ).toThrow()
    return repo
  }

  it('accepts the paused run its own spawn started', async () => {
    const { repoPath } = pausedRun(ACTION)
    await expect(headMovedOnlyByRebaseRun(ACTION, { cwd: repoPath })).resolves.toBe(true)
  })

  it('rejects a replacement run with the same endpoints started by anything else', async () => {
    const { repoPath, git } = pausedRun(ACTION)
    git('rebase', '--abort')
    expect(() => git('rebase', 'main')).toThrow()
    await expect(headMovedOnlyByRebaseRun(ACTION, { cwd: repoPath })).resolves.toBe(false)
  })
})
