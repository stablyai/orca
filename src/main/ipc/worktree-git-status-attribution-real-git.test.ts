// Real-binary coverage: `git add` in one linked worktree must attribute its
// status signal to that checkout only, through the real watcher, the admin dir
// names Git picks (which need not match the folder name), and the head-identity
// memo that maps them back to checkout paths.
import { execFile } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { areRuntimePathsEqual } from '../../shared/worktree/ownership'
import { collectLocalWorktreeBaseChanges } from './worktree-base-directory-change-collector'
import type { WorktreeBaseWatchTarget } from './worktree-base-directory-event-filter'
import {
  startWorktreeBaseDirectoryPoller,
  type WorktreeBasePollEvent,
  type WorktreeBaseSubscription
} from './worktree-base-directory-poller'
import { cachedWorktreePathsForScope } from './worktree-head-identity-cached-paths'
import {
  createWorktreeHeadIdentityCache,
  readGitCommonHeadIdentities,
  type WorktreeHeadIdentityCache
} from './worktree-head-identity-reader'

const execFileAsync = promisify(execFile)
const POLL_MS = 25

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd })
  return stdout
}

async function listedWorktreePaths(cwd: string): Promise<string[]> {
  return (await git(['worktree', 'list', '--porcelain'], cwd))
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length))
}

let scratch = ''
let primary = ''
let linkedOne = ''
let linkedTwo = ''
let target: WorktreeBaseWatchTarget
let cache: WorktreeHeadIdentityCache
let poller: WorktreeBaseSubscription | null = null
let received: WorktreeBasePollEvent[] = []

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'orca-status-attribution-'))
  primary = join(scratch, 'repo')
  await git(['init', '-q', '-b', 'main', primary], scratch)
  for (const [key, value] of [
    ['user.name', 'Orca Test'],
    ['user.email', 'orca@example.test'],
    ['commit.gpgSign', 'false']
  ]) {
    await git(['config', key, value], primary)
  }
  await git(['commit', '-q', '--allow-empty', '-m', 'init'], primary)
  // Same folder name twice: Git names the second admin dir `wt1`, not `wt`.
  linkedOne = join(scratch, 'one', 'wt')
  linkedTwo = join(scratch, 'two', 'wt')
  await git(['worktree', 'add', '-q', linkedOne, '-b', 'one'], primary)
  await git(['worktree', 'add', '-q', linkedTwo, '-b', 'two'], primary)

  // Production watches the canonical common dir (see watch-targets `addTarget`).
  const commonDir = await realpath(join(primary, '.git'))
  target = {
    key: `git-common:local:${commonDir}`,
    kind: 'git-common',
    path: commonDir,
    repos: new Map([['repo-1', { repoId: 'repo-1', repoName: 'repo', nestWorkspaces: false }]])
  }
  cache = createWorktreeHeadIdentityCache()
  await readGitCommonHeadIdentities(commonDir, cache)
  received = []
  poller = await startWorktreeBaseDirectoryPoller(
    target,
    () => target.repos,
    (events) => received.push(...events),
    { pollIntervalMs: POLL_MS }
  )
})

afterEach(async () => {
  await poller?.unsubscribe()
  poller = null
  await rm(scratch, { recursive: true, force: true })
})

// The native watcher can deliver a previous stage's events late; drain them.
async function waitForQuietWatcher(): Promise<void> {
  let seen = -1
  while (seen !== received.length) {
    seen = received.length
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
}

/** Stages a file in `checkout` and returns the checkout paths its status signal names. */
async function stageAndAttribute(checkout: string): Promise<string[] | null> {
  await waitForQuietWatcher()
  received = []
  await writeFile(join(checkout, 'staged.txt'), `${checkout}\n`)
  await git(['add', 'staged.txt'], checkout)
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const changes = collectLocalWorktreeBaseChanges(target, received)
    if (changes.gitStatusRepoIds.length > 0) {
      return cachedWorktreePathsForScope(cache, changes.gitStatusScope)
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
  throw new Error(`no status signal for ${checkout}; events: ${JSON.stringify(received)}`)
}

function expectAttributedTo(paths: string[] | null, listed: string, others: string[]): void {
  expect(paths).not.toBeNull()
  expect(paths?.some((path) => areRuntimePathsEqual(path, listed))).toBe(true)
  for (const other of others) {
    expect(paths?.some((path) => areRuntimePathsEqual(path, other))).toBe(false)
  }
}

describe('git status signal attribution (real git)', () => {
  it('attributes index writes to the checkout that staged, in `git worktree list` spelling', async () => {
    const [listedPrimary, listedOne, listedTwo] = await listedWorktreePaths(primary)
    expectAttributedTo(await stageAndAttribute(linkedTwo), listedTwo, [listedPrimary, listedOne])
    expectAttributedTo(await stageAndAttribute(linkedOne), listedOne, [listedPrimary, listedTwo])
    expectAttributedTo(await stageAndAttribute(primary), listedPrimary, [listedOne, listedTwo])
  }, 30_000)
})
