// A real project checkout a benchmarked bot may read: each thread gets its own throwaway clone with no
// remotes, and git in the harness refuses to push, so nothing a bot does can leave the scratch home.
import { constants } from 'node:fs'
import { access, chmod, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { runProcess } from '@orca/process-host'

async function git(args: string[]): Promise<string> {
  const result = await runProcess({
    program: 'git',
    args,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeoutMs: 120_000
  })
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.slice(-300)}`)
  }
  return result.stdout
}

/** A workspace's own repository with its recent commits, oldest first, at the times given. */
export async function commitHistory(
  dir: string,
  branch: string,
  commits: readonly { message: string; at: number }[]
): Promise<void> {
  await git(['init', '--quiet', '--initial-branch', branch, dir])
  for (const commit of commits) {
    const date = new Date(commit.at).toISOString()
    const result = await runProcess({
      program: 'git',
      args: ['-C', dir, 'commit', '--quiet', '--allow-empty', '-m', commit.message],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Owner',
        GIT_AUTHOR_EMAIL: 'owner@example.invalid',
        GIT_COMMITTER_NAME: 'Owner',
        GIT_COMMITTER_EMAIL: 'owner@example.invalid',
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeoutMs: 60_000
    })
    if (result.code !== 0) {
      throw new Error(`git commit in ${dir} failed: ${result.stderr.slice(-300)}`)
    }
  }
}

/** A workspace row whose fixture carries `commits` gets a real repository there, so `git log` reads them. */
export async function withCommitHistories(
  rows: Record<string, unknown>[] | undefined,
  root: string
): Promise<Record<string, unknown>[] | undefined> {
  if (!rows) {
    return rows
  }
  return Promise.all(
    rows.map(async ({ commits, ...row }) => {
      if (!Array.isArray(commits)) {
        return row
      }
      const path = join(root, String(row.displayName))
      await commitHistory(path, String(row.branch).replace(/^refs\/heads\//, ''), commits)
      return { ...row, path }
    })
  )
}

/** Clones `source` into `dest` sharing its objects, then drops every remote. */
export async function cloneCheckout(source: string, dest: string): Promise<void> {
  await git(['clone', '--shared', '--quiet', source, dest])
  for (const remote of (await git(['-C', dest, 'remote'])).split('\n').filter(Boolean)) {
    await git(['-C', dest, 'remote', 'remove', remote])
  }
  if ((await git(['-C', dest, 'remote'])).trim()) {
    throw new Error(`could not remove the remotes of ${dest}`)
  }
}

/** HEAD, every ref (stash included) and the working tree; throws when git cannot say. */
export async function checkoutSnapshot(dir: string): Promise<string> {
  const [head, refs, tree] = await Promise.all([
    git(['-C', dir, 'rev-parse', 'HEAD']),
    git(['-C', dir, 'for-each-ref', '--format=%(refname) %(objectname)']),
    git(['-C', dir, 'status', '--porcelain', '--untracked-files=all'])
  ])
  return `${head}\n${refs}\n${tree}`
}

/** Fails closed: a snapshot git cannot take counts as changed. */
export async function checkoutChanged(dir: string, before: string): Promise<boolean> {
  try {
    return (await checkoutSnapshot(dir)) !== before
  } catch {
    return true
  }
}

/** Puts a `git` ahead of the real one in the stand-in's bin that refuses to push. */
export async function installGitPushGuard(standInDir: string): Promise<void> {
  const bin = join(standInDir, 'bin')
  const real = await findOnPath('git', bin)
  // Any word `push` or `send-pack` refuses, wherever it sits: a false refusal is safe, a missed push is not.
  const script = [
    '#!/bin/sh',
    'for arg in "$@"; do',
    '  case "$arg" in push|send-pack) echo "git $arg is not available here." >&2; exit 1 ;; esac',
    'done',
    `exec "${real}" "$@"`,
    ''
  ].join('\n')
  await writeFile(join(bin, 'git'), script)
  await chmod(join(bin, 'git'), 0o755)
}

async function findOnPath(name: string, skip: string): Promise<string> {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(dir, name)
    if (
      dir &&
      dir !== skip &&
      (await access(candidate, constants.X_OK).then(
        () => true,
        () => false
      ))
    ) {
      return candidate
    }
  }
  throw new Error(`${name} is not on PATH`)
}
