import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach } from 'vitest'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { GitPushTarget } from '../../shared/worktree/types'
import type { GitRemoteExec, WorktreePushTargetStore } from './worktree-push-target-cleanup'
import '../persistence/loading-store/worktree-meta-write-normalization'
import './worktree-push-target-cleanup'
import './worktree-push-target-refspec-migration'
import './worktree-push-target-reconciliation'

const execFileAsync = promisify(execFile)
let isolatedGitEnv: NodeJS.ProcessEnv

const REPO_ID = 'repo-1'
const FORK_REMOTE = 'pr-contributor-orca'

let scratchDir = ''
let repoPath = ''
let forkPath = ''

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, env: isolatedGitEnv })
  return stdout
}

const execGit: GitRemoteExec = (args, cwd) =>
  execFileAsync('git', args, { cwd, env: isolatedGitEnv })

function worktreeId(suffix: string): string {
  return `${REPO_ID}::${suffix}`
}

function forkTarget(overrides: Partial<GitPushTarget> = {}): GitPushTarget {
  return {
    remoteName: FORK_REMOTE,
    branchName: 'contributor/fix',
    remoteUrl: forkPath,
    remoteCreated: true,
    ...overrides
  }
}

function storeOf(entries: Record<string, GitPushTarget | undefined>): WorktreePushTargetStore {
  const meta: Record<string, WorktreeMeta> = {}
  for (const [id, pushTarget] of Object.entries(entries)) {
    meta[id] = { pushTarget } as unknown as WorktreeMeta
  }
  return { getAllWorktreeMeta: () => meta }
}

beforeEach(async () => {
  // macOS temp aliases must match Git's canonical paths.
  scratchDir = await realpath(await mkdtemp(join(tmpdir(), 'orca-pr-remote-reconcile-')))
  const home = join(scratchDir, 'home')
  await mkdir(home)
  isolatedGitEnv = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))
    ),
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(home, 'empty'),
    GIT_TERMINAL_PROMPT: '0'
  }
  repoPath = join(scratchDir, 'repo')
  forkPath = join(scratchDir, 'fork')
  await mkdir(repoPath, { recursive: true })
  await git(['init', '-q'], repoPath)
  await git(['config', 'user.name', 'Orca Test'], repoPath)
  await git(['config', 'user.email', 'orca@example.test'], repoPath)
  await git(['config', 'commit.gpgSign', 'false'], repoPath)
  await git(['config', 'core.hooksPath', '.git/no-hooks'], repoPath)
  await writeFile(join(repoPath, 'seed.txt'), 'seed\n')
  await git(['add', '-A'], repoPath)
  await git(['commit', '-qm', 'seed'], repoPath)

  await git(['clone', '-q', repoPath, forkPath], scratchDir)
  await git(['config', 'user.name', 'Orca Test'], forkPath)
  await git(['config', 'user.email', 'orca@example.test'], forkPath)
  await git(['config', 'commit.gpgSign', 'false'], forkPath)
  await git(['config', 'core.hooksPath', '.git/no-hooks'], forkPath)
  await git(['checkout', '-qb', 'contributor/fix'], forkPath)
  await writeFile(join(forkPath, 'fork.txt'), 'fork change\n')
  await git(['add', '-A'], forkPath)
  await git(['commit', '-qm', 'fork change'], forkPath)

  await git(['remote', 'add', FORK_REMOTE, forkPath], repoPath)
  await git(['config', '--local', `remote.${FORK_REMOTE}.orca-created`, 'true'], repoPath)
  await git(
    [
      'fetch',
      FORK_REMOTE,
      `+refs/heads/contributor/fix:refs/remotes/${FORK_REMOTE}/contributor/fix`
    ],
    repoPath
  )
})

afterEach(async () => {
  await rm(scratchDir, { recursive: true, force: true })
})

export {
  isolatedGitEnv,
  git,
  execGit,
  REPO_ID,
  FORK_REMOTE,
  scratchDir,
  repoPath,
  forkPath,
  worktreeId,
  forkTarget,
  storeOf
}
