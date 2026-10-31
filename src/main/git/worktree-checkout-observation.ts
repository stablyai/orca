import { throwIfSignalAborted } from '../../shared/abort-signal-reason'
import type { GitWorktreeInfo } from '../../shared/worktree/types'
import type { GitWorktreeExecOptions } from './worktree-operation-options'
import { gitExecOptions } from './worktree-operation-options'
import { gitExecFileAsync } from './runner'
import { assertWslUncPathRunning } from '../wsl/wsl-unc-access-gate'

import { isWorktreeHeadOid, isWorktreeBranchRef } from '../../shared/git-worktree-checkout-facts'

/** Empty prefix attributes the verified HEAD to this checkout root, never an enclosing repository. */
export async function readWorktreeCheckout(
  worktreePath: string,
  options: GitWorktreeExecOptions = {},
  isCurrent: () => boolean = () => true
): Promise<Pick<GitWorktreeInfo, 'head' | 'branch'>> {
  const beforeRead = async (): Promise<void> => {
    throwIfSignalAborted(options.signal)
    if (!isCurrent()) {
      throw new Error('Worktree observation superseded')
    }
    await assertWslUncPathRunning(worktreePath, options.wslDistro)
    throwIfSignalAborted(options.signal)
    if (!isCurrent()) {
      throw new Error('Worktree observation superseded')
    }
  }
  const execOptions = {
    ...gitExecOptions(worktreePath, options),
    canStart: async () => {
      await beforeRead()
      return true
    }
  }
  await beforeRead()
  const { stdout } = await gitExecFileAsync(
    ['rev-parse', '--show-prefix', '--verify', 'HEAD'],
    execOptions
  )
  const lines = stdout.replace(/\r?\n$/, '').split(/\r?\n/)
  const [prefix, head] = lines
  if (lines.length !== 2 || prefix !== '' || !head || !isWorktreeHeadOid(head)) {
    throw new Error('Worktree HEAD could not be attributed to its checkout')
  }
  await beforeRead()
  const ref = await gitExecFileAsync(
    ['rev-parse', '--symbolic-full-name', '--verify', 'HEAD'],
    execOptions
  )
  const branch = ref.stdout.replace(/\r?\n$/, '')
  if (branch !== 'HEAD' && !isWorktreeBranchRef(branch)) {
    throw new Error('Worktree branch could not be verified')
  }
  await beforeRead()
  return { head, branch: branch === 'HEAD' ? '' : branch }
}
