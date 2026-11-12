import {
  type BranchSwitchTarget,
  type BranchSwitchCreation,
  isBranchNameValid
} from '../../../../shared/git/branch-switch-target'
import { gitExecFileAsync } from '../../command-runner/git-exec-file'
import {
  gitOptionsForWorktree,
  type GitRuntimeOptions
} from '../../command-runner/git-runtime-options'
import { readGitCommandFailureStderr } from '../../../../shared/git/commands/git-command-failure-text'

export class BranchSwitchCollisionError extends Error {
  constructor(readonly branch: string) {
    super(`A local branch named ${branch} already exists. Switch to that branch instead.`)
  }
  get data() {
    return { existingBranch: this.branch }
  }
}

export async function readCurrentBranch(
  worktreePath: string,
  options: GitRuntimeOptions
): Promise<string | null> {
  try {
    const { stdout } = await gitExecFileAsync(
      ['symbolic-ref', '--quiet', '--short', 'HEAD'],
      gitOptionsForWorktree(worktreePath, options)
    )
    return stdout.trim() || null
  } catch {
    return null
  }
}

export async function readBranchSwitchHead(
  worktreePath: string,
  options: GitRuntimeOptions
): Promise<string | undefined> {
  try {
    const { stdout } = await gitExecFileAsync(
      ['rev-parse', '--verify', 'HEAD'],
      gitOptionsForWorktree(worktreePath, options)
    )
    return stdout.trim() || undefined
  } catch {
    return undefined
  }
}

export async function validateNewBranchName(
  path: string,
  name: string,
  options: GitRuntimeOptions
): Promise<void> {
  if (!isBranchNameValid(name)) {
    throw new Error('This branch name is invalid. Choose a different name.')
  }
  await gitExecFileAsync(
    ['check-ref-format', '--branch', name],
    gitOptionsForWorktree(path, options)
  ).catch(() => {
    throw new Error('This branch name is invalid. Choose a different name.')
  })
}

export async function resolveBranchSwitchTarget(
  path: string,
  target: BranchSwitchTarget,
  options: GitRuntimeOptions
): Promise<{ branch: string; creation?: BranchSwitchCreation }> {
  const execution = gitOptionsForWorktree(path, { ...options, admissionTier: 'interactive' })
  const run = (args: string[]) => gitExecFileAsync(args, execution)
  if (target.kind === 'new') {
    await validateNewBranchName(path, target.name, { ...options, admissionTier: 'interactive' })
    return { branch: target.name, creation: { kind: 'new' } }
  }
  if (!isBranchNameValid(target.name)) {
    throw new Error('This branch name is invalid. Choose a different name.')
  }
  const full =
    target.kind === 'local'
      ? `refs/heads/${target.name}`
      : `refs/remotes/${target.name.replace(/^refs\/remotes\//, '')}`
  const { stdout } = await run([
    'for-each-ref',
    '--format=%(refname)%09%(upstream)%09%(symref)',
    target.kind === 'remote' ? 'refs/heads/' : full,
    ...(target.kind === 'remote' ? [full] : [])
  ])
  const rows = stdout
    .trim()
    .split('\n')
    .map((line) => line.split('\t'))
  const selected = rows.find((row) => row[0] === full)
  if (!selected || selected[2]) {
    throw new Error(
      'This branch is no longer available. Refresh the branch list and choose another branch.'
    )
  }
  if (target.kind === 'local') {
    return { branch: target.name }
  }
  const tracker = rows.find((row) => row[0]?.startsWith('refs/heads/') && row[1] === full)
  if (tracker?.[0]) {
    return { branch: tracker[0].slice('refs/heads/'.length) }
  }
  const remotes = (
    await run(['remote']).catch((error) => {
      if (options.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw error
      }
      throw new Error(
        "Orca couldn't read this repository's remotes. Check its remote settings in a terminal, then try again."
      )
    })
  ).stdout
    .trim()
    .split('\n')
    .sort((a, b) => b.length - a.length)
  const remotePath = full.slice('refs/remotes/'.length)
  const remote = remotes.find((name) => name && remotePath.startsWith(`${name}/`))
  if (!remote) {
    throw new Error(
      'This remote is no longer configured. Fetch from a configured remote, then try again.'
    )
  }
  const branch = remotePath.slice(remote.length + 1)
  if (rows.some((row) => row[0] === `refs/heads/${branch}`)) {
    throw new BranchSwitchCollisionError(branch)
  }
  return { branch, creation: { kind: 'remote', startPoint: full } }
}

export function branchSwitchFailure(error: unknown, branch: string): Error {
  if (error instanceof BranchSwitchCollisionError) {
    return error
  }
  const text = readGitCommandFailureStderr(error) ?? (error instanceof Error ? error.message : '')
  if (/already exists/.test(text)) {
    return new BranchSwitchCollisionError(branch)
  }
  const occupied = /(?:already checked out at|already used by worktree at) ['"](.+?)['"]/.exec(text)
  if (occupied) {
    return new Error(
      `Checked out in ${occupied[1]}. Open that workspace or switch its branch in a terminal, then try again.`
    )
  }
  const tracking = branchSwitchTrackingFailure(text, branch)
  if (tracking) {
    return new Error(tracking)
  }
  return new Error(
    "Orca couldn't switch branches. Check this repository in a terminal, then try again."
  )
}

export function branchSwitchTrackingFailure(text: string, branch: string): string | null {
  if (/cannot set up tracking information/.test(text)) {
    return `Orca couldn't set up tracking for ${branch} because this remote branch isn't included in the remote's fetch settings. Update that remote's fetch settings, fetch the branch, then try again.`
  }
  if (/could not lock config|config.*lock|config.lock/.test(text)) {
    return "Orca couldn't set up tracking because another Git action is updating this repository. Wait for it to finish, then try again."
  }
  return null
}
