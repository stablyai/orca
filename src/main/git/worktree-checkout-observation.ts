import { throwIfSignalAborted } from '../../shared/abort-signal-reason'
import type { GitWorktreeInfo } from '../../shared/worktree/types'
import type { GitWorktreeExecOptions } from './worktree-operation-options'
import { getErrorCode, gitExecOptions } from './worktree-operation-options'
import { gitExecFileAsync } from './runner'
import { assertWslUncPathRunning } from '../wsl/wsl-unc-access-gate'

/** A failed read is unknown; only exit 1 with a verified HEAD establishes a detached checkout. */
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
  const { stdout } = await gitExecFileAsync(['rev-parse', '--verify', 'HEAD'], execOptions)
  const head = stdout.trim()
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(head)) {
    throw new Error('Worktree HEAD could not be verified')
  }
  await beforeRead()
  try {
    const ref = await gitExecFileAsync(['symbolic-ref', '--quiet', 'HEAD'], execOptions)
    const branch = ref.stdout.trim()
    if (!branch.startsWith('refs/heads/')) {
      throw new Error('Worktree branch could not be verified')
    }
    return { head, branch }
  } catch (error) {
    if (getErrorCode(error) === '1') {
      return { head, branch: '' }
    }
    throw error
  }
}
