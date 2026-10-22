import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findGitBlameHunkForLine } from '../../../shared/git-blame-porcelain-parser'
import type { GitBlameResult } from '../../../shared/git-blame-types'
import { getFileBlame } from './file-blame'

function git(cwd: string, args: string[], author?: string): void {
  const env = author
    ? {
        ...process.env,
        GIT_AUTHOR_NAME: author,
        GIT_AUTHOR_EMAIL: `${author.toLowerCase()}@example.com`
      }
    : process.env
  execFileSync('git', args, { cwd, stdio: 'pipe', env })
}

function authorOfLine(result: GitBlameResult | null, line: number): string | undefined {
  const hunk = result ? findGitBlameHunkForLine(result.hunks, line) : null
  return hunk ? result?.commits[hunk.sha]?.author : undefined
}

describe('getFileBlame against real Git', () => {
  let repo: string

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), 'orca-blame-real-git-'))
    git(repo, ['init', '-q'])
    git(repo, ['config', 'user.email', 'committer@example.com'])
    git(repo, ['config', 'user.name', 'Committer'])
  })

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true })
  })

  it('attributes each line to the author who last changed it', async () => {
    await writeFile(path.join(repo, 'file.txt'), 'one\ntwo\nthree\n')
    git(repo, ['add', 'file.txt'])
    git(repo, ['commit', '-qm', 'initial'], 'Alice')
    await writeFile(path.join(repo, 'file.txt'), 'one\nTWO\nthree\n')
    git(repo, ['commit', '-qam', 'shout two'], 'Bob')

    const result = await getFileBlame(repo, { filePath: 'file.txt' })

    expect([1, 2, 3].map((line) => authorOfLine(result, line))).toEqual(['Alice', 'Bob', 'Alice'])
    const bobHunk = result ? findGitBlameHunkForLine(result.hunks, 2) : null
    expect(bobHunk && result?.commits[bobHunk.sha]).toMatchObject({
      authorEmail: 'bob@example.com',
      summary: 'shout two',
      uncommitted: false
    })
  })

  it('blames an unsaved buffer from stdin so inserted lines shift the attribution', async () => {
    await writeFile(path.join(repo, 'file.txt'), 'one\ntwo\n')
    git(repo, ['add', 'file.txt'])
    git(repo, ['commit', '-qm', 'initial'], 'Alice')

    const result = await getFileBlame(repo, {
      filePath: 'file.txt',
      contents: 'zero\none\ntwo\n'
    })

    const firstHunk = result ? findGitBlameHunkForLine(result.hunks, 1) : null
    expect(firstHunk && result?.commits[firstHunk.sha]?.uncommitted).toBe(true)
    expect(authorOfLine(result, 2)).toBe('Alice')
    expect(authorOfLine(result, 3)).toBe('Alice')
  })

  it('returns null for an untracked file and for a folder that is not a repository', async () => {
    await writeFile(path.join(repo, 'seed.txt'), 'seed\n')
    git(repo, ['add', 'seed.txt'])
    git(repo, ['commit', '-qm', 'seed'], 'Alice')
    await writeFile(path.join(repo, 'untracked.txt'), 'new\n')
    const plainFolder = mkdtempSync(path.join(tmpdir(), 'orca-blame-no-repo-'))
    await writeFile(path.join(plainFolder, 'notes.txt'), 'notes\n')

    try {
      expect(await getFileBlame(repo, { filePath: 'untracked.txt' })).toBeNull()
      expect(await getFileBlame(plainFolder, { filePath: 'notes.txt' })).toBeNull()
    } finally {
      await rm(plainFolder, { recursive: true, force: true })
    }
  })

  it('returns null before the first commit', async () => {
    await writeFile(path.join(repo, 'file.txt'), 'draft\n')
    git(repo, ['add', 'file.txt'])

    expect(await getFileBlame(repo, { filePath: 'file.txt' })).toBeNull()
  })
})
