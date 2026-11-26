import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NgitMutationResult } from '../../shared/ngit/ngit-work-item-types'
import { gitExecFileAsync } from '../git/command-runner/git-exec-file'
import { execNgit, type NgitExec } from './ngit-cli'
import { fetchNgitPullRequestBase } from './pull-request-worktree-base'
import type { ProjectedWorkItem } from './work-item-projection'

type Git = (cwd: string, args: string[]) => Promise<string>

function failed(error: string): NgitMutationResult {
  return { ok: false, error }
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

async function defaultBranch(git: Git, repoPath: string, remote: string): Promise<string | null> {
  const head = await git(repoPath, [
    'symbolic-ref',
    '--short',
    `refs/remotes/${remote}/HEAD`
  ]).catch(() => '')
  if (head) {
    return head.slice(remote.length + 1)
  }
  for (const name of ['main', 'master']) {
    const ref = `refs/remotes/${remote}/${name}`
    if (await git(repoPath, ['rev-parse', '--verify', '-q', ref]).catch(() => '')) {
      return name
    }
  }
  return null
}

async function checkoutOf(git: Git, repoPath: string, branch: string): Promise<string | null> {
  const list = await git(repoPath, ['worktree', 'list', '--porcelain'])
  for (const entry of list.split(/\r?\n\r?\n/)) {
    const lines = entry.split(/\r?\n/)
    if (lines.includes(`branch refs/heads/${branch}`)) {
      return lines[0].replace(/^worktree /, '')
    }
  }
  return null
}

/**
 * ngit publishes the merged status on push only for the repository's declared default branch, so it
 * is always asked for; asking again for an applied pull request publishes nothing.
 */
async function publishApplied(
  cwd: string,
  remote: string,
  target: string,
  eventId: string,
  exec: NgitExec
): Promise<NgitMutationResult> {
  try {
    await exec(
      ['--repo', remote, 'pr', 'applied', eventId, `--reason=landed on ${target}`, '--json'],
      cwd
    )
    return { ok: true }
  } catch (error) {
    return failed(
      `The changes are on ${remote}/${target}, but publishing the merged status failed: ${message(error)}. Click merge again to retry.`
    )
  }
}

/** Merges in `cwd`, which has `target` checked out, then pushes and publishes the status. */
async function mergeAndPush(
  git: Git,
  cwd: string,
  remote: string,
  target: string,
  eventId: string,
  exec: NgitExec
): Promise<NgitMutationResult> {
  if (await git(cwd, ['status', '--porcelain', '--untracked-files=no'])) {
    return failed(`Merge failed: ${cwd} has uncommitted changes on ${target}.`)
  }
  await git(cwd, ['fetch', remote, target])
  // Never rewrites or merges local history that the remote does not have.
  await git(cwd, ['merge', '--ff-only', `${remote}/${target}`])
  const before = await git(cwd, ['rev-parse', 'HEAD'])
  if (before !== (await git(cwd, ['rev-parse', `${remote}/${target}`]))) {
    return failed(`Merge failed: local ${target} has commits ${remote} does not. Push them first.`)
  }
  let mergeError: string | null = null
  try {
    await exec(['--repo', remote, 'pr', 'merge', eventId, '--json'], cwd)
  } catch (error) {
    mergeError = message(error)
  }
  if (await git(cwd, ['rev-parse', '--verify', '-q', 'MERGE_HEAD']).catch(() => '')) {
    await git(cwd, ['merge', '--abort'])
    return failed(`Merge failed: conflicts with ${target}. Resolve them in a terminal.`)
  }
  if (mergeError || before === (await git(cwd, ['rev-parse', 'HEAD']))) {
    return failed(`Merge failed: ${mergeError ?? 'ngit made no merge commit.'}`)
  }
  try {
    await git(cwd, ['push', remote, `refs/heads/${target}:refs/heads/${target}`])
  } catch (error) {
    return failed(
      `Merged into local ${target}, but the push failed: ${message(error)}. Run \`git push ${remote} ${target}\`.`
    )
  }
  return publishApplied(cwd, remote, target, eventId, exec)
}

export async function mergeNgitPullRequest(
  repoPath: string,
  pull: ProjectedWorkItem,
  remote: string,
  localGitOptions: { wslDistro?: string } = {},
  exec: NgitExec = execNgit
): Promise<NgitMutationResult> {
  const git: Git = async (cwd, args) =>
    (await gitExecFileAsync(args, { cwd, ...localGitOptions })).stdout.trim()
  try {
    await git(repoPath, ['fetch', remote])
    const target = pull.item.baseRefName ?? (await defaultBranch(git, repoPath, remote))
    if (!target) {
      return failed('Merge failed: could not tell which branch this pull request targets.')
    }
    // `ngit pr merge` needs the commits locally; a patch series carries its own.
    if (!pull.item.isPatch) {
      const base = await fetchNgitPullRequestBase(repoPath, pull, localGitOptions)
      if (!base.ok) {
        return failed(base.error)
      }
    }
    const { headSha, eventId, isPatch } = pull.item
    // An earlier merge, here or in a terminal, may have landed without its status.
    const landed =
      !isPatch &&
      headSha !== undefined &&
      (await git(repoPath, ['merge-base', '--is-ancestor', headSha, `${remote}/${target}`]).then(
        () => true,
        () => false
      ))
    if (landed) {
      return await publishApplied(repoPath, remote, target, eventId, exec)
    }
    const existing = await checkoutOf(git, repoPath, target)
    if (existing) {
      return await mergeAndPush(git, existing, remote, target, eventId, exec)
    }
    // A throwaway checkout, so no workspace the user has open changes branch.
    const parent = await mkdtemp(join(tmpdir(), 'orca-ngit-merge-'))
    const checkout = join(parent, 'checkout')
    try {
      const local = await git(repoPath, ['rev-parse', '--verify', '-q', `refs/heads/${target}`])
        .then(() => true)
        .catch(() => false)
      await git(
        repoPath,
        local
          ? ['worktree', 'add', checkout, target]
          : ['worktree', 'add', '--track', '-b', target, checkout, `${remote}/${target}`]
      )
      return await mergeAndPush(git, checkout, remote, target, eventId, exec)
    } finally {
      await git(repoPath, ['worktree', 'remove', '--force', checkout]).catch(() => '')
      await rm(parent, { recursive: true, force: true })
    }
  } catch (error) {
    return failed(`Merge failed: ${message(error)}`)
  }
}
