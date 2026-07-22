import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listWorktrees, parseCoreSparseCheckoutFlag } from './worktree'

const tempRoots: string[] = []

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
}

async function createRepoWithTwoDirs(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'orca-sparse-checkout-'))
  tempRoots.push(root)
  const repoPath = path.join(root, 'repo')

  execFileSync('git', ['init', '--quiet', repoPath])
  git(repoPath, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(repoPath, ['config', 'user.email', 'test@example.com'])
  git(repoPath, ['config', 'user.name', 'Test User'])
  await mkdir(path.join(repoPath, 'keep'), { recursive: true })
  await writeFile(path.join(repoPath, 'keep', 'file.txt'), 'keep\n')
  await mkdir(path.join(repoPath, 'drop'), { recursive: true })
  await writeFile(path.join(repoPath, 'drop', 'file.txt'), 'drop\n')
  git(repoPath, ['add', '-A'])
  git(repoPath, ['commit', '--quiet', '-m', 'initial'])

  return realpath(repoPath)
}

function mainWorktree(worktrees: Awaited<ReturnType<typeof listWorktrees>>) {
  const found = worktrees.find((worktree) => worktree.isMainWorktree)
  if (!found) {
    throw new Error('expected a main worktree in the listing')
  }
  return found
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('sparse-checkout detection', () => {
  it.skipIf(process.platform === 'win32')(
    'reports isSparse while sparse checkout is enabled',
    async () => {
      const repoPath = await createRepoWithTwoDirs()

      git(repoPath, ['sparse-checkout', 'set', 'keep'])

      expect(mainWorktree(await listWorktrees(repoPath)).isSparse).toBe(true)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'does not report isSparse after disable leaves the pattern file behind',
    async () => {
      const repoPath = await createRepoWithTwoDirs()

      git(repoPath, ['sparse-checkout', 'set', 'keep'])
      git(repoPath, ['sparse-checkout', 'disable'])

      // Regression guard: `git sparse-checkout disable` restores the full
      // working tree but deliberately keeps <gitdir>/info/sparse-checkout so the
      // checkout can be re-enabled. Detection must not treat the leftover file
      // as "still sparse" (that produced a false "files are not on disk" badge).
      const patternFile = path.join(repoPath, '.git', 'info', 'sparse-checkout')
      await expect(stat(patternFile)).resolves.toMatchObject({})

      expect(mainWorktree(await listWorktrees(repoPath)).isSparse).toBeFalsy()
    }
  )
})

describe('parseCoreSparseCheckoutFlag', () => {
  it('reads an enabled flag from the [core] section', () => {
    expect(parseCoreSparseCheckoutFlag('[core]\n\tsparseCheckout = true\n')).toBe(true)
  })

  it('reads a disabled flag written by `sparse-checkout disable`', () => {
    expect(parseCoreSparseCheckoutFlag('[core]\n\tsparseCheckout = false\n')).toBe(false)
  })

  it('returns undefined when the flag is absent', () => {
    expect(parseCoreSparseCheckoutFlag('[core]\n\tbare = false\n')).toBeUndefined()
    expect(parseCoreSparseCheckoutFlag('')).toBeUndefined()
  })

  it('honors the last assignment when the key repeats', () => {
    expect(
      parseCoreSparseCheckoutFlag('[core]\n\tsparseCheckout = true\n\tsparseCheckout = false\n')
    ).toBe(false)
  })

  it('is case-insensitive for the section and key names', () => {
    expect(parseCoreSparseCheckoutFlag('[CORE]\n\tSPARSECHECKOUT = TRUE\n')).toBe(true)
  })

  it('treats a valueless boolean as true', () => {
    expect(parseCoreSparseCheckoutFlag('[core]\n\tsparseCheckout\n')).toBe(true)
  })

  it('ignores a [core "subsection"] header', () => {
    expect(parseCoreSparseCheckoutFlag('[core "sub"]\n\tsparseCheckout = true\n')).toBeUndefined()
  })

  it('ignores a matching key outside the [core] section', () => {
    expect(parseCoreSparseCheckoutFlag('[other]\n\tsparseCheckout = true\n')).toBeUndefined()
  })

  it('ignores an inline comment after the value', () => {
    expect(parseCoreSparseCheckoutFlag('[core]\n\tsparseCheckout = true # on\n')).toBe(true)
  })
})
