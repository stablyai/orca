import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkIgnoredPaths } from './check-ignored-paths'

const tempRoots: string[] = []

function git(repo: string, args: string[]): void {
  execFileSync('git', args, { cwd: repo })
}

async function createRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), 'orca-check-ignored-'))
  tempRoots.push(repo)
  git(repo, ['init', '-q'])
  git(repo, ['config', 'user.email', 'test@example.com'])
  git(repo, ['config', 'user.name', 'Test User'])
  git(repo, ['config', 'commit.gpgsign', 'false'])
  return repo
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('checkIgnoredPaths', () => {
  it('still answers for the other paths when one lies inside a submodule', async () => {
    const child = await createRepo()
    await writeFile(path.join(child, 'README.md'), 'child\n')
    git(child, ['add', '.'])
    git(child, ['commit', '-q', '-m', 'child'])
    const repo = await createRepo()
    await writeFile(path.join(repo, '.gitignore'), '*.log\n')
    git(repo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', child, 'vendor/sub'])

    await expect(
      checkIgnoredPaths(repo, ['debug.log', 'vendor/sub', 'vendor/sub/README.md'])
    ).resolves.toEqual(['debug.log'])
  })
})
