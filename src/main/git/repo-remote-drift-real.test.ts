import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getRecentDriftSubjects, getRemoteDrift } from './repo'

describe('remote drift real Git contract', () => {
  const tempPaths: string[] = []

  afterEach(() => {
    for (const path of tempPaths.splice(0)) {
      rmSync(path, { recursive: true, force: true })
    }
  })

  it('preserves clean, diverged, and missing-ref results', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'orca-remote-drift-'))
    tempPaths.push(repoPath)
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: repoPath, encoding: 'utf8' })

    git('init', '--quiet')
    git('config', 'user.name', 'Orca Test')
    git('config', 'user.email', 'orca@example.test')
    git('config', 'commit.gpgSign', 'false')
    git('config', 'core.hooksPath', '.git/no-hooks')
    writeFileSync(join(repoPath, 'fixture.txt'), 'base\n')
    git('add', 'fixture.txt')
    git('commit', '-m', 'base')
    git('branch', '-M', 'fixture-base')
    git('branch', 'feature')

    writeFileSync(join(repoPath, 'fixture.txt'), 'remote one\n')
    git('commit', '-am', 'remote one')
    writeFileSync(join(repoPath, 'fixture.txt'), 'remote two\n')
    git('commit', '-am', 'remote two')
    git('update-ref', 'refs/remotes/origin/main', 'HEAD')

    git('checkout', '--quiet', 'feature')
    writeFileSync(join(repoPath, 'local.txt'), 'local one\n')
    git('add', 'local.txt')
    git('commit', '-m', 'local one')

    await expect(getRemoteDrift(repoPath, 'HEAD', 'origin/main')).resolves.toEqual({
      ahead: 1,
      behind: 2
    })
    await expect(getRecentDriftSubjects(repoPath, 'HEAD', 'origin/main', 5)).resolves.toEqual([
      'remote two',
      'remote one'
    ])
    await expect(getRemoteDrift(repoPath, 'origin/main', 'origin/main')).resolves.toEqual({
      ahead: 0,
      behind: 0
    })
    await expect(
      getRecentDriftSubjects(repoPath, 'origin/main', 'origin/main', 5)
    ).resolves.toEqual([])
    await expect(getRemoteDrift(repoPath, 'HEAD', 'missing-ref')).resolves.toBeNull()
    await expect(getRecentDriftSubjects(repoPath, 'HEAD', 'missing-ref', 5)).resolves.toEqual([])
  })
})
