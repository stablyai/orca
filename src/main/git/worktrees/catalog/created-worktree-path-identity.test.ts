// Real Git: a created worktree's path must match `git worktree list`, which keys the registry.
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { installRealWorkerThreadChildProcesses } from '../../../worker-thread-child-process/worker-thread-child-process-real.test-fixtures'
import { removeTree } from '../../../../shared/file-write/windows-transient-lock-removal'
import { describeCreatedWorktree, listWorktreesStrict } from './worktree-listing'
import { resolveRegisteredWorktreePath } from './worktree-path-comparison'

const execFileAsync = promisify(execFile)

installRealWorkerThreadChildProcesses()

let scratchDir = ''

async function git(args: string[], cwd: string): Promise<void> {
  await execFileAsync('git', args, { cwd })
}

beforeEach(async () => {
  scratchDir = await realpath(await mkdtemp(join(tmpdir(), 'orca-created-worktree-path-')))
})

afterEach(async () => {
  await removeTree(scratchDir)
})

// Git >= 2.48 writes a relative backlink with useRelativePaths; older Git ignores the key.
it.each(['false', 'true'])(
  'reports the registered spelling when the parent folder differs only in case (useRelativePaths=%s)',
  async (useRelativePaths) => {
    const repoPath = join(scratchDir, 'repo')
    await mkdir(repoPath)
    // Case-insensitive volumes (macOS, Windows) resolve `my-repo` to this folder.
    await mkdir(join(scratchDir, 'My-Repo'))
    await git(['init', '-q', '-b', 'main'], repoPath)
    await git(
      [
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@example.invalid',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'seed'
      ],
      repoPath
    )
    const requestedPath = join(scratchDir, 'my-repo', 'my-task')
    await git(
      [
        '-c',
        `worktree.useRelativePaths=${useRelativePaths}`,
        'worktree',
        'add',
        '-q',
        '-b',
        'my-task',
        requestedPath
      ],
      repoPath
    )

    const listed = (await listWorktreesStrict(repoPath)).find(
      (worktree) => !worktree.isMainWorktree
    )
    const created = await describeCreatedWorktree(repoPath, requestedPath, 'my-task')

    expect(listed?.path).toBeTruthy()
    expect(created?.path).toBe(listed?.path)
  }
)

it.each([
  ['absolute', '/v/my-repo/t/.git\n', '/v/repo/.git/worktrees/t', '/v/My-Repo/t', '/v/my-repo/t'],
  [
    'relative',
    '../../../../my-repo/t/.git\n',
    '/v/repo/.git/worktrees/t',
    '/v/My-Repo/t',
    '/v/my-repo/t'
  ],
  // posix.normalize collapses a UNC `//` root, so the join no longer matches Git's listing.
  [
    'UNC relative',
    '../../../../wt/.git\n',
    '//server/share/repo/.git/worktrees/wt',
    '//server/share/wt',
    '//server/share/wt'
  ],
  ['stale', '/v/moved/t/.git\n', '/v/repo/.git/worktrees/t', '/v/My-Repo/t', '/v/My-Repo/t'],
  ['empty', '', '/v/repo/.git/worktrees/t', '/v/My-Repo/t', '/v/My-Repo/t']
])(
  'adopts a %s backlink only when it differs from the toplevel by case',
  (_, file, gitDir, topLevel, expected) => {
    expect(resolveRegisteredWorktreePath(file, gitDir, topLevel)).toBe(expected)
  }
)
