import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Two feature commits each conflict with one main commit on the same files. */
export function createConflictingRebaseRepo(tempPaths: string[]) {
  const repoPath = mkdtempSync(join(tmpdir(), 'orca-continue-rebase-'))
  tempPaths.push(repoPath)
  const git = (...args: string[]): string =>
    execFileSync('git', args, {
      cwd: repoPath,
      encoding: 'utf8',
      env: { ...process.env, GIT_EDITOR: 'true', GIT_CONFIG_NOSYSTEM: '1', HOME: repoPath },
      stdio: ['ignore', 'pipe', 'pipe']
    })
  const write = (file: string, text: string) => writeFileSync(join(repoPath, file), text)
  git('init', '--quiet', '-b', 'main')
  git('config', 'user.name', 'Orca Test')
  git('config', 'user.email', 'orca@example.test')
  git('config', 'commit.gpgSign', 'false')
  git('config', 'core.hooksPath', '.git/no-hooks')
  // Local, so Git and the code under test agree whatever the machine's global config says.
  git('config', 'merge.conflictStyle', 'merge')
  write('a.txt', 'base\n')
  write('b.txt', 'base\n')
  write('c.txt', 'base\n')
  git('add', '.')
  git('commit', '--quiet', '-m', 'base')
  git('checkout', '--quiet', '-b', 'feature')
  write('a.txt', 'feature a\n')
  git('commit', '--quiet', '-am', 'feature a')
  write('b.txt', 'feature b\n')
  git('commit', '--quiet', '-am', 'feature b')
  git('checkout', '--quiet', 'main')
  write('a.txt', 'main a\n')
  write('b.txt', 'main b\n')
  write('c.txt', 'main c\n')
  git('commit', '--quiet', '-am', 'main edits')
  git('checkout', '--quiet', 'feature')
  return { repoPath, git, write }
}
