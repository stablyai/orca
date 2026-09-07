import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getBranchConflictKind } from './repo-branch-conflict'

describe('branch conflict real Git contract', () => {
  const tempPaths: string[] = []

  afterEach(() => {
    for (const path of tempPaths.splice(0)) {
      rmSync(path, { recursive: true, force: true })
    }
  })

  it('decides remote conflicts from one batched probe across many remotes', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'orca-branch-conflict-'))
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
    git('commit', '--quiet', '-m', 'base')
    const head = git('rev-parse', 'HEAD').trim()

    // Many remotes is the shape that used to cost one subprocess each.
    for (let index = 0; index < 12; index += 1) {
      git('remote', 'add', `remote${index}`, 'https://example.test/repo.git')
    }
    git('update-ref', 'refs/remotes/remote7/taken', head)

    await expect(getBranchConflictKind(repoPath, 'taken')).resolves.toBe('remote')
    await expect(getBranchConflictKind(repoPath, 'free')).resolves.toBeNull()
    // The allowed base ref is the one remote spelling that is not a conflict.
    await expect(
      getBranchConflictKind(repoPath, 'taken', 'refs/remotes/remote7/taken')
    ).resolves.toBeNull()

    git('branch', 'local-only', head)
    await expect(getBranchConflictKind(repoPath, 'local-only')).resolves.toBe('local')
  })
})
