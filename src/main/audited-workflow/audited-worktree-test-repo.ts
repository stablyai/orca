// Real-repository fixtures for audited-worktree tests. Creates throwaway Git
// repos with the actual `git` binary — provisioning correctness cannot be
// demonstrated against a mocked Git.
//
// Not a *.test.ts file so several suites can share it; it is test-only support
// and is never imported by production code.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalizeAllowingMissing } from './audited-worktree-managed-root'

export type TestRepo = {
  repoPath: string
  workspaceRoot: string
  headCommit: string
  cleanup: () => void
}

export function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  }).trim()
}

/**
 * Creates a repo with one commit plus a sibling workspace root, so the managed
 * root never lands inside the repository (which provisioning refuses).
 */
export function createTestRepo(options: { origin?: string } = {}): TestRepo {
  const root = mkdtempSync(join(tmpdir(), 'orca-audited-'))
  const repoPath = canonicalizeAllowingMissing(join(root, 'repo'))
  const workspaceRoot = canonicalizeAllowingMissing(join(root, 'workspaces'))

  execFileSync('git', ['init', '-q', '-b', 'main', repoPath], { encoding: 'utf8' })
  git(repoPath, ['config', 'user.email', 'test@example.com'])
  git(repoPath, ['config', 'user.name', 'Test'])
  git(repoPath, ['config', 'commit.gpgsign', 'false'])
  execFileSync('git', ['-C', repoPath, 'commit', '-q', '--allow-empty', '-m', 'initial'], {
    encoding: 'utf8'
  })
  if (options.origin) {
    git(repoPath, ['remote', 'add', 'origin', options.origin])
  }
  const headCommit = git(repoPath, ['rev-parse', 'HEAD'])

  return {
    repoPath,
    workspaceRoot,
    headCommit,
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true })
      } catch {
        // Windows can hold locks on freshly-used Git dirs; a leaked temp dir is
        // harmless and must never fail a test.
      }
    }
  }
}

export function listRefs(repoPath: string): string[] {
  return git(repoPath, ['for-each-ref', '--format=%(refname) %(objectname)'])
    .split('\n')
    .filter(Boolean)
    .sort()
}

export function statusPorcelain(repoPath: string): string {
  return git(repoPath, ['status', '--porcelain'])
}

export function trackedFileHashes(repoPath: string): string {
  return git(repoPath, ['ls-files', '-s'])
}
