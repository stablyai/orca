import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getBlame } from './blame'

const repositories: string[] = []

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

function createRepository(): string {
  const repository = mkdtempSync(join(tmpdir(), 'orca-git-blame-'))
  repositories.push(repository)
  git(repository, ['init', '--quiet'])
  git(repository, ['config', 'user.name', 'Blame Test'])
  git(repository, ['config', 'user.email', 'blame@example.com'])
  return repository
}

afterEach(() => {
  for (const repository of repositories.splice(0)) {
    rmSync(repository, { recursive: true, force: true })
  }
})

describe('getBlame with the real Git binary', () => {
  it('attributes saved working-tree changes to an uncommitted range', async () => {
    const repository = createRepository()
    writeFileSync(join(repository, 'tracked.txt'), 'committed\noriginal\n')
    git(repository, ['add', '--', 'tracked.txt'])
    git(repository, ['commit', '--quiet', '-m', 'initial'])

    writeFileSync(join(repository, 'tracked.txt'), 'committed\nchanged\n')

    const result = await getBlame(repository, 'tracked.txt')
    expect(result.ranges).toHaveLength(2)
    expect(result.ranges[0]).toMatchObject({ startLine: 1, endLine: 1 })
    expect(result.ranges[0]?.commitId).toMatch(/^[0-9a-f]{40,64}$/)
    expect(result.ranges[1]).toMatchObject({ startLine: 2, endLine: 2, commitId: null })
  })

  it('keeps option-shaped filenames behind the path separator', async () => {
    const repository = createRepository()
    writeFileSync(join(repository, '--contents'), 'tracked\n')
    git(repository, ['add', '--', '--contents'])
    git(repository, ['commit', '--quiet', '-m', 'option-shaped path'])

    const result = await getBlame(repository, '--contents')
    expect(result.ranges).toHaveLength(1)
    expect(result.ranges[0]?.commitId).toMatch(/^[0-9a-f]{40,64}$/)
  })

  it('rejects paths outside the selected worktree before invoking Git', async () => {
    const repository = createRepository()

    await expect(getBlame(repository, '../outside.txt')).rejects.toThrow(
      'git blame path escapes the selected worktree'
    )
    await expect(getBlame(repository, join(repository, 'tracked.txt'))).rejects.toThrow(
      'invalid git blame path'
    )
  })
})
