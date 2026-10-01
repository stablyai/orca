import { gitExecFileAsync } from './runner'
import type { GitWorktreeExecOptions } from './worktree-operation-options'
import { gitExecOptions } from './worktree-operation-options'

export async function persistWorktreeCreationBase(
  worktreePath: string,
  branch: string,
  effectiveBase: string,
  options: GitWorktreeExecOptions = {}
): Promise<void> {
  const configKey = `branch.${branch}.base`
  try {
    await gitExecFileAsync(['config', '--local', '--replace-all', configKey, effectiveBase], {
      ...gitExecOptions(worktreePath, options)
    })
  } catch (error) {
    console.warn(`addWorktree: failed to set ${configKey} for ${worktreePath}`, error)
    try {
      // Why: reused branch names may carry stale base metadata; if replacement fails, unset it so consumers don't trust stale lineage.
      await gitExecFileAsync(['config', '--local', '--unset-all', configKey], {
        ...gitExecOptions(worktreePath, options)
      })
    } catch (unsetError) {
      console.warn(
        `addWorktree: failed to unset stale ${configKey} for ${worktreePath}`,
        unsetError
      )
    }
  }
}

export async function configurePushAutoSetupRemote(
  worktreePath: string,
  options: GitWorktreeExecOptions
): Promise<void> {
  try {
    // Why: `--get` (not `--local --get`) treats a value at any scope as an explicit user choice.
    let alreadySet = false
    try {
      await gitExecFileAsync(['config', '--get', 'push.autoSetupRemote'], {
        ...gitExecOptions(worktreePath, options)
      })
      alreadySet = true
    } catch (readError) {
      // Why: exit 1 means unset; other codes are real read failures and must not overwrite config.
      const code = (readError as { code?: unknown })?.code
      if (code !== 1) {
        throw readError
      }
    }
    if (!alreadySet) {
      await gitExecFileAsync(['config', '--local', 'push.autoSetupRemote', 'true'], {
        ...gitExecOptions(worktreePath, options)
      })
    }
  } catch (error) {
    console.warn(`addWorktree: failed to set push.autoSetupRemote for ${worktreePath}`, error)
  }
}

export async function unsetWorktreeCreationBase(
  worktreePath: string,
  branch: string,
  options: GitWorktreeExecOptions = {}
): Promise<void> {
  try {
    await gitExecFileAsync(['config', '--local', '--unset-all', `branch.${branch}.base`], {
      ...gitExecOptions(worktreePath, options)
    })
  } catch {
    // Best-effort cleanup; leave the original sparse-setup error as the actionable failure.
  }
}
