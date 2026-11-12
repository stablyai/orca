import { execFileSync } from 'node:child_process'
import { lstatSync } from 'node:fs'
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readTreeIntoPlainIndex, transferCleanIndexStats } from './worktree-index-stat-transfer'

const tempRoots: string[] = []

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
}

function indexedInode(cwd: string, path: string): number {
  return Number(/ino: (\d+)/.exec(git(cwd, ['ls-files', '--debug', '--', path]))?.[1])
}

/** A main checkout plus a `--no-checkout` worktree holding clones of its files. */
async function createClonedWorktree(
  files: Record<string, string>,
  edit: (repo: string) => Promise<void>
) {
  const root = await mkdtemp(join(tmpdir(), 'orca-index-stat-'))
  tempRoots.push(root)
  const repoPath = join(root, 'repo')
  execFileSync('git', ['init', '--quiet', repoPath])
  git(repoPath, ['config', 'user.email', 'test@example.com'])
  git(repoPath, ['config', 'user.name', 'Test User'])
  const past = new Date('2020-01-01T00:00:00Z')
  for (const [path, content] of Object.entries(files)) {
    await writeFile(join(repoPath, path), content)
    await utimes(join(repoPath, path), past, past)
  }
  git(repoPath, ['add', '.'])
  git(repoPath, ['commit', '--quiet', '-m', 'initial'])
  await edit(repoPath)
  const worktreePath = join(root, 'worktree')
  git(repoPath, ['worktree', 'add', '--quiet', '--no-checkout', '-b', 'feature', worktreePath])
  for (const path of Object.keys(files)) {
    execFileSync('cp', ['-c', join(repoPath, path), join(worktreePath, path)])
  }
  await readTreeIntoPlainIndex(worktreePath, 'HEAD', {})
  return { repoPath, worktreePath }
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe.runIf(process.platform === 'darwin')('transferCleanIndexStats', () => {
  it('records stat data only for clones of files Git knows are clean', async () => {
    const { repoPath, worktreePath } = await createClonedWorktree(
      { 'clean.txt': 'clean\n', 'racy.txt': 'racy\n', 'dirty.txt': 'dirty\n' },
      async (repo) => {
        // An entry not older than its index is "racily clean": Git rereads it, so must we.
        const future = new Date('2100-01-01T00:00:00Z')
        await utimes(join(repo, 'racy.txt'), future, future)
        git(repo, ['update-index', '--refresh'])
        await writeFile(join(repo, 'dirty.txt'), 'edited\n')
      }
    )

    expect(await transferCleanIndexStats(repoPath, worktreePath)).toBe(1)

    expect(indexedInode(worktreePath, 'clean.txt')).toBe(
      lstatSync(join(worktreePath, 'clean.txt')).ino
    )
    expect(indexedInode(worktreePath, 'racy.txt')).toBe(0)
    expect(indexedInode(worktreePath, 'dirty.txt')).toBe(0)
    expect(git(worktreePath, ['status', '--porcelain'])).toBe(' M dirty.txt\n')
  })

  it('trusts nothing when the main checkout has edited attributes', async () => {
    const { repoPath, worktreePath } = await createClonedWorktree(
      { '.gitattributes': '*.txt text\n', 'clean.txt': 'clean\n' },
      (repo) => writeFile(join(repo, '.gitattributes'), '*.txt text eol=crlf\n')
    )

    expect(await transferCleanIndexStats(repoPath, worktreePath)).toBe(0)
    expect(indexedInode(worktreePath, 'clean.txt')).toBe(0)
  })
})
