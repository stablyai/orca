import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Test-only git environment that no ambient config can reach. A developer shell or CI
 * runner carrying `url.<base>.insteadOf` — or Orca's own `GIT_CONFIG_COUNT` injection —
 * rewrites what `git remote -v` prints, which silently changes the canonical remote key
 * remote-identity tests assert on.
 *
 * Stays on the Git 2.25 baseline: `GIT_CONFIG_GLOBAL` needs 2.32, so global config is
 * redirected by moving `HOME`/`USERPROFILE`/`XDG_CONFIG_HOME` instead.
 *
 * Apply the entries to `process.env` (`vi.stubEnv`) rather than to one spawn: the code
 * under test spawns its own git and inherits the ambient environment. The caller owns
 * `root` and must remove it, or every test that calls this leaves a temp dir behind.
 */
export function createIsolatedGitEnv(): { root: string; entries: Record<string, string> } {
  const root = mkdtempSync(join(tmpdir(), 'orca-git-config-'))
  return {
    root,
    entries: {
      HOME: root,
      USERPROFILE: root,
      XDG_CONFIG_HOME: join(root, '.config'),
      GIT_CONFIG_NOSYSTEM: '1',
      // Overrides any inherited count; `GIT_CONFIG_KEY_*` entries past it are ignored.
      GIT_CONFIG_COUNT: '0'
    }
  }
}

/** Initializes a repo with a single `origin`. Requires the isolated env to be applied. */
export function initGitRepoWithOrigin(repoPath: string, originUrl?: string): void {
  // `git init -b` needs 2.28; the default branch name is irrelevant to these tests.
  execFileSync('git', ['init'], { cwd: repoPath, stdio: 'ignore' })
  if (originUrl) {
    execFileSync('git', ['remote', 'add', 'origin', originUrl], { cwd: repoPath, stdio: 'ignore' })
  }
}
