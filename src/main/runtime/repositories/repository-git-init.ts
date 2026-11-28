import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  repoCreateFailure,
  type RepoCreateFailure
} from '../../../shared/repository/creation/repo-create-failure-copy'
import { gitExecFileAsync } from '../../git/command-runner/git-exec-file'

export async function initializeCreatedGitRepo(
  targetPath: string,
  createdDir: boolean
): Promise<RepoCreateFailure | null> {
  let step: 'init' | 'commit' = 'init'
  try {
    // Host Git on purpose: the new repo has no project yet, even inside one.
    await gitExecFileAsync(['init'], { cwd: targetPath, hostGit: true })
    step = 'commit'
    await gitExecFileAsync(['commit', '--allow-empty', '-m', 'Initial commit'], {
      cwd: targetPath,
      // Host Git on purpose: the new repo has no project yet, even inside one.
      hostGit: true
    })
    return null
  } catch (error) {
    if (createdDir) {
      await rm(targetPath, { recursive: true, force: true }).catch(() => {})
    } else if (step === 'commit') {
      await rm(join(targetPath, '.git'), {
        recursive: true,
        force: true
      }).catch(() => {})
    }
    const message = error instanceof Error ? error.message : String(error)
    if (step === 'commit' && /Please tell me who you are|user\.name|user\.email/i.test(message)) {
      return repoCreateFailure('gitIdentityMissing')
    }
    return repoCreateFailure(step === 'init' ? 'gitInitFailed' : 'initialCommitFailed', {
      detail: message
    })
  }
}
