import { runProcessSync } from '@orca/process-host'
import { mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const ORIGIN_URL = 'https://example.invalid/acme/app.git'
export const FORK_URL = 'https://example.invalid/fork/app.git'

/** Fixture Git runs outside the code under test so seeded subprocess counters only see lookups. */
export function fixtureGit(cwd: string, ...argv: string[]): string {
  const result = runProcessSync({ program: 'git', args: argv, cwd })
  if (result.code !== 0) {
    throw new Error(`Fixture git ${argv[0]} failed: ${result.stderr}`)
  }
  return result.stdout.trim()
}

/** Call from afterEach: the fixture points Git at its own global config. */
export function restoreGitConfigEnv(saved: { global?: string; nosystem?: string }): void {
  for (const [name, value] of [
    ['GIT_CONFIG_GLOBAL', saved.global],
    ['GIT_CONFIG_NOSYSTEM', saved.nosystem]
  ] as const) {
    if (value === undefined) {
      delete process.env[name]
    } else {
      process.env[name] = value
    }
  }
}

export type LinkedWorktreeFixture = {
  root: string
  repoPath: string
  worktreePath: string
  globalConfigPath: string
}

/**
 * A main checkout on `main` tracking origin, and a linked worktree on `feature` whose own
 * config.worktree tracks and pushes `feature` on the fork. (`branch.*.merge` is multi-valued and Git
 * takes the first value, so only the single-valued remote is overridden.) No network: remotes are only config.
 */
export async function createLinkedWorktreeFixture(roots: string[]): Promise<LinkedWorktreeFixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orca-tracked-upstream-')))
  roots.push(root)
  const globalConfigPath = join(root, 'global.gitconfig')
  await writeFile(globalConfigPath, '')
  // Isolate both the fixture and the code under test from the developer's global/system config.
  process.env.GIT_CONFIG_GLOBAL = globalConfigPath
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  fixtureGit(root, 'init', '--quiet', 'repo')
  const repoPath = join(root, 'repo')
  fixtureGit(repoPath, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  fixtureGit(repoPath, 'config', 'user.name', 'Tracked Upstream Test')
  fixtureGit(repoPath, 'config', 'user.email', 'test@example.com')
  fixtureGit(repoPath, 'config', 'core.hooksPath', join(root, 'no-hooks'))
  fixtureGit(repoPath, 'commit', '--quiet', '--allow-empty', '-m', 'base')
  fixtureGit(repoPath, 'remote', 'add', 'origin', ORIGIN_URL)
  fixtureGit(repoPath, 'remote', 'add', 'fork', FORK_URL)
  fixtureGit(repoPath, 'branch', 'feature')
  fixtureGit(repoPath, 'config', 'branch.feature.remote', 'origin')
  fixtureGit(repoPath, 'config', 'branch.feature.merge', 'refs/heads/feature')
  fixtureGit(repoPath, 'config', 'extensions.worktreeConfig', 'true')
  const worktreePath = join(root, 'wt')
  fixtureGit(repoPath, 'worktree', 'add', '--quiet', worktreePath, 'feature')
  fixtureGit(worktreePath, 'config', '--worktree', 'branch.feature.remote', 'fork')
  fixtureGit(worktreePath, 'config', '--worktree', 'push.default', 'current')
  return { root, repoPath, worktreePath, globalConfigPath }
}
