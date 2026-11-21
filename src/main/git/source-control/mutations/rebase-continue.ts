import { readFile, stat } from 'node:fs/promises'
import * as path from 'node:path'
import type {
  ContinueRebaseAction,
  ContinueRebaseRequest,
  ContinueRebaseResult,
  RebaseStopToken
} from '../../../../shared/git/status/git-status-types'
import { addWslEnvKeys } from '../../../../shared/shell/wsl/wsl-env'
import { runWithGitWorktreeOperationLock } from '../../../../shared/git/worktrees/git-worktree-operation-lock'
import {
  type GitRuntimeOptions,
  gitOptionsForWorktree
} from '../../command-runner/git-runtime-options'
import { gitExecFileAsync } from '../../command-runner/git-exec-file'
import { runWithGitReadCacheInvalidation } from '../git-read-cache-invalidation'
import { resolveGitDir } from '../resolve-git-dir'
import { AUTOSTASH_REAPPLY_CONFLICT, detectConflictOperation } from './git-conflict-operation'
import { takeOrcaRebaseProvenance } from './orca-rebase-provenance'
import { joinGitOutput, readGitErrorOutput } from './git-command-output'

// Git's own words for a pick the resolution left empty (apply backend; merge backend in older Git).
const EMPTY_PICK_OUTPUT = /No changes - did you forget to use 'git add'|nothing to commit/i

/**
 * `inspect` reads the current stop without changing anything. `continue` runs only when the
 * rebase is still at the stop the caller was shown, so a retry after an unknown settlement
 * cannot advance a later stop the user never saw.
 */
export async function continueRebase(
  worktreePath: string,
  action: ContinueRebaseAction = 'continue',
  options: GitRuntimeOptions & ContinueRebaseRequest = {}
): Promise<ContinueRebaseResult> {
  const { expected, ...gitOptions } = options
  return runWithGitWorktreeOperationLock(worktreePath, gitOptions.signal, () =>
    runWithGitReadCacheInvalidation(() =>
      action === 'inspect'
        ? inspectRebaseStop(worktreePath, gitOptions)
        : continueRebaseUnlocked(worktreePath, expected, gitOptions)
    )
  )
}

async function inspectRebaseStop(
  worktreePath: string,
  options: GitRuntimeOptions
): Promise<ContinueRebaseResult> {
  if ((await detectConflictOperation(worktreePath, options)) !== 'rebase') {
    return { outcome: 'not_rebasing' }
  }
  return {
    outcome: 'inspected',
    stop: await readRebaseStopToken(worktreePath, options),
    branch: await readRebasingBranch(worktreePath, options)
  }
}

async function continueRebaseUnlocked(
  worktreePath: string,
  expected: RebaseStopToken | undefined,
  options: GitRuntimeOptions
): Promise<ContinueRebaseResult> {
  if ((await detectConflictOperation(worktreePath, options)) !== 'rebase') {
    return { outcome: 'not_rebasing' }
  }
  // Why: picks open the commit-message editor and Orca has no TTY; this keeps Git's prepared message.
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_EDITOR: 'true' }
  if (process.platform === 'win32') {
    addWslEnvKeys(env, ['GIT_EDITOR'])
  }
  const branch = await readRebasingBranch(worktreePath, options)
  // Contract: the token is re-read under the worktree lock immediately before the spawn, so no Orca
  // action can move the rebase in between. A Git process outside Orca acting inside that window is
  // out of scope: Git has no compare-and-swap on rebase state.
  const before = await readRebaseStopToken(worktreePath, options)
  if (!expected || !sameStop(expected, before)) {
    return { outcome: 'stale', stop: before, branch }
  }
  let output: string
  let exitedCleanly: boolean
  try {
    const { stdout, stderr } = await gitExecFileAsync(['rebase', '--continue'], {
      ...gitOptionsForWorktree(worktreePath, options),
      env
    })
    output = joinGitOutput(stdout, stderr)
    exitedCleanly = true
  } catch (error) {
    output = readGitErrorOutput(error)
    exitedCleanly = false
  }

  if ((await detectConflictOperation(worktreePath, options)) !== 'rebase') {
    if (!exitedCleanly) {
      return { outcome: 'failed', message: output, branch }
    }
    const integratedUpstreamOid = takeOrcaRebaseProvenance(worktreePath, branch, before.incarnation)
    return {
      outcome: AUTOSTASH_REAPPLY_CONFLICT.test(output)
        ? 'completed_autostash_conflict'
        : 'completed',
      ...(AUTOSTASH_REAPPLY_CONFLICT.test(output) ? { message: output } : {}),
      branch,
      ...(integratedUpstreamOid ? { integratedUpstreamOid } : {})
    }
  }
  const stop = await readRebaseStopToken(worktreePath, options)
  const stopped = { message: output, stop, branch }
  // Interactive edit/break stops exit 0 mid-rebase; report them, never as done.
  if (exitedCleanly) {
    return { outcome: 'stopped', ...stopped }
  }
  // Dropped empty picks advance the step without moving HEAD; exec failures leave no unmerged paths.
  const advanced = stop.head !== before.head || stop.step !== before.step
  if (advanced && (await hasUnmergedPaths(worktreePath, options))) {
    return { outcome: 'conflicted', ...stopped }
  }
  if (
    !advanced &&
    EMPTY_PICK_OUTPUT.test(output) &&
    !(await hasUnmergedPaths(worktreePath, options)) &&
    (await gitDiffIsQuiet(worktreePath, ['--cached', 'HEAD'], options))
  ) {
    return { outcome: 'empty', ...stopped }
  }
  return { outcome: 'failed', ...stopped }
}

// Every field must be known on both sides; a missing one can never prove it is the same stop.
function sameStop(a: RebaseStopToken, b: RebaseStopToken): boolean {
  return (
    a.head !== null &&
    a.step !== null &&
    a.incarnation !== null &&
    a.head === b.head &&
    a.step === b.step &&
    a.incarnation === b.incarnation
  )
}

export async function readRebaseStopToken(
  worktreePath: string,
  options: GitRuntimeOptions
): Promise<RebaseStopToken> {
  const gitDir = await resolveGitDir(worktreePath, options)
  const readState = async (file: string): Promise<string | null> => {
    for (const dir of ['rebase-merge', 'rebase-apply']) {
      try {
        return (await readFile(path.join(gitDir, dir, file), 'utf8')).trim()
      } catch {
        // Only one backend's directory exists.
      }
    }
    return null
  }
  // msgnum (merge backend) or next (apply backend) is the step; onto + orig-head name the run.
  const step = (await readState('msgnum')) ?? (await readState('next'))
  const onto = await readState('onto')
  const origHead = await readState('orig-head')
  // An identical abort and restart rewrites the same onto/orig-head; the new state dir does not.
  const runId = await readRebaseDirIdentity(gitDir)
  return {
    head: await readHead(worktreePath, options),
    step,
    incarnation: onto && origHead && runId ? `${runId}:${onto}:${origHead}` : null
  }
}

/** onto and orig-head of the paused run, so a caller can tell its own rebase from another. */
export async function readRebaseRunFiles(
  worktreePath: string,
  options: GitRuntimeOptions
): Promise<{ onto: string | null; origHead: string | null }> {
  const gitDir = await resolveGitDir(worktreePath, options)
  const read = async (file: string): Promise<string | null> => {
    for (const dir of ['rebase-merge', 'rebase-apply']) {
      try {
        return (await readFile(path.join(gitDir, dir, file), 'utf8')).trim()
      } catch {
        // Only one backend's directory exists.
      }
    }
    return null
  }
  return { onto: await read('onto'), origHead: await read('orig-head') }
}

/** The branch the paused rebase will update (its head-name file); null for a detached rebase. */
export async function readRebasingBranch(
  worktreePath: string,
  options: GitRuntimeOptions
): Promise<string | null> {
  const gitDir = await resolveGitDir(worktreePath, options)
  for (const dir of ['rebase-merge', 'rebase-apply']) {
    try {
      const ref = (await readFile(path.join(gitDir, dir, 'head-name'), 'utf8')).trim()
      return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null
    } catch {
      // Only one backend's directory exists.
    }
  }
  return null
}

/** Which rebase directory exists and its inode/birth time; null when no rebase is in progress. */
export async function readRebaseRunIdentity(
  worktreePath: string,
  options: GitRuntimeOptions
): Promise<string | null> {
  return readRebaseDirIdentity(await resolveGitDir(worktreePath, options))
}

async function readRebaseDirIdentity(gitDir: string): Promise<string | null> {
  for (const dir of ['rebase-merge', 'rebase-apply']) {
    try {
      const info = await stat(path.join(gitDir, dir), { bigint: true })
      // Never ctime: Git adds and removes files in this dir on every step. Birth time is 0 where
      // the filesystem lacks it, leaving the inode alone to tell runs apart.
      return `${dir}:${info.ino}:${info.birthtimeNs}`
    } catch {
      // Only one backend's directory exists.
    }
  }
  return null
}

async function readHead(worktreePath: string, options: GitRuntimeOptions): Promise<string | null> {
  try {
    const { stdout } = await gitExecFileAsync(
      ['rev-parse', '--verify', '-q', 'HEAD'],
      gitOptionsForWorktree(worktreePath, options)
    )
    return stdout.trim() || null
  } catch {
    return null
  }
}

async function hasUnmergedPaths(
  worktreePath: string,
  options: GitRuntimeOptions
): Promise<boolean> {
  try {
    const { stdout } = await gitExecFileAsync(
      ['diff', '--name-only', '--diff-filter=U'],
      gitOptionsForWorktree(worktreePath, options)
    )
    return stdout.trim().length > 0
  } catch {
    return false
  }
}

async function gitDiffIsQuiet(
  worktreePath: string,
  args: string[],
  options: GitRuntimeOptions
): Promise<boolean> {
  try {
    await gitExecFileAsync(
      ['diff', '--quiet', ...args, '--'],
      gitOptionsForWorktree(worktreePath, options)
    )
    return true
  } catch {
    return false
  }
}
