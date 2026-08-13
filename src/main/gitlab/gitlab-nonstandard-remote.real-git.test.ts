import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { gitExecFileAsync } from '../git/runner'
import { _resetProjectRefCache, getIssueProjectRef } from './gitlab-project-ref-resolution'

const describeWithGit =
  spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0 ? describe : describe.skip

describeWithGit('GitLab nonstandard remote with the real Git binary', () => {
  let repoPath = ''

  beforeEach(async () => {
    repoPath = await mkdtemp(join(tmpdir(), 'orca-gitlab-remote-'))
    await gitExecFileAsync(['init'], { cwd: repoPath })
    await gitExecFileAsync(['remote', 'add', 'myremote', 'git@gitlab.com:group/project.git'], {
      cwd: repoPath
    })
    _resetProjectRefCache()
  })

  afterEach(async () => {
    if (repoPath) {
      await rm(repoPath, { recursive: true, force: true })
    }
  })

  it('resolves the same project before and after naming the sole remote origin', async () => {
    await expect(getIssueProjectRef(repoPath, ['gitlab.com'])).resolves.toEqual({
      host: 'gitlab.com',
      path: 'group/project'
    })

    await gitExecFileAsync(['remote', 'rename', 'myremote', 'origin'], { cwd: repoPath })
    _resetProjectRefCache()

    await expect(getIssueProjectRef(repoPath, ['gitlab.com'])).resolves.toEqual({
      host: 'gitlab.com',
      path: 'group/project'
    })
  })
})
