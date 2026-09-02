import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listWorktrees, parseCoreSparseCheckoutFlag, removeWorktree } from './worktree'

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

  it.skipIf(process.platform === 'win32')(
    'ignores config.worktree while extensions.worktreeConfig is off',
    async () => {
      const repoPath = await createRepoWithTwoDirs()

      git(repoPath, ['sparse-checkout', 'set', 'keep'])
      git(repoPath, ['config', 'extensions.worktreeConfig', 'false'])
      git(repoPath, ['config', 'core.sparseCheckout', 'false'])
      await writeFile(
        path.join(repoPath, '.git', 'config.worktree'),
        '[core]\n\tsparseCheckout = true\n'
      )

      expect(git(repoPath, ['config', '--get', 'core.sparseCheckout']).trim()).toBe('false')
      expect(mainWorktree(await listWorktrees(repoPath)).isSparse).toBeFalsy()
    }
  )

  it.skipIf(process.platform === 'win32')(
    'honors config.worktree while extensions.worktreeConfig is on',
    async () => {
      const repoPath = await createRepoWithTwoDirs()

      git(repoPath, ['sparse-checkout', 'set', 'keep'])
      git(repoPath, ['config', 'extensions.worktreeConfig', 'true'])
      git(repoPath, ['config', 'core.sparseCheckout', 'false'])
      await writeFile(
        path.join(repoPath, '.git', 'config.worktree'),
        '[core]\n\tsparseCheckout = true\n'
      )

      expect(git(repoPath, ['config', '--get', 'core.sparseCheckout']).trim()).toBe('true')
      expect(mainWorktree(await listWorktrees(repoPath)).isSparse).toBe(true)
    }
  )
})

describe('sparse-checkout cache invalidation across the worktree lifecycle', () => {
  it.skipIf(process.platform === 'win32')(
    'does not leak a stale sparse badge onto a worktree created at a removed worktree`s path',
    async () => {
      const repoPath = await createRepoWithTwoDirs()
      const linkedPath = path.join(path.dirname(repoPath), 'linked')

      git(repoPath, ['worktree', 'add', '-b', 'sparse-branch', linkedPath])
      git(linkedPath, ['sparse-checkout', 'set', 'keep'])

      const beforeRemoval = await listWorktrees(repoPath)
      const sparseRow = beforeRemoval.find((worktree) => worktree.branch.endsWith('sparse-branch'))
      expect(sparseRow?.isSparse).toBe(true)

      // Removing through Orca's own removeWorktree (not a raw `git worktree remove`) exercises the
      // cache-invalidation hook this listing now relies on instead of a fresh stat every time.
      await removeWorktree(repoPath, linkedPath, true)
      git(repoPath, ['worktree', 'add', '-b', 'full-branch', linkedPath])

      const afterRecreate = await listWorktrees(repoPath)
      const fullRow = afterRecreate.find((worktree) => worktree.branch.endsWith('full-branch'))
      expect(fullRow?.isSparse).toBeFalsy()
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

  // Git's config parser is character- not line-based, so a header may be followed on the same line
  // by the assignment. Every expectation below was confirmed against `git config --file --get`.
  it('reads an assignment on the same line as the section header', () => {
    expect(parseCoreSparseCheckoutFlag('[core] sparseCheckout = true\n')).toBe(true)
    expect(parseCoreSparseCheckoutFlag('[core] sparseCheckout = false\n')).toBe(false)
    expect(parseCoreSparseCheckoutFlag('[core]sparseCheckout=true\n')).toBe(true)
    expect(parseCoreSparseCheckoutFlag('[core] sparseCheckout\n')).toBe(true)
  })

  it('keeps the section open for later lines after a same-line assignment', () => {
    expect(
      parseCoreSparseCheckoutFlag('[core] sparseCheckout = false\n\tsparseCheckout = true\n')
    ).toBe(true)
  })

  it('lets the last header on a line decide the section', () => {
    expect(parseCoreSparseCheckoutFlag('[core "sub"] [core] sparseCheckout = true\n')).toBe(true)
    expect(parseCoreSparseCheckoutFlag('[core] [other] sparseCheckout = true\n')).toBeUndefined()
  })

  it('ignores a same-line assignment under a [core "subsection"] header', () => {
    expect(parseCoreSparseCheckoutFlag('[core "sub"] sparseCheckout = true\n')).toBeUndefined()
  })

  it('leaves [core] when a subsection header carries its own same-line assignment', () => {
    // A `[section "sub"]key = value` line matched neither branch of the old anchored regex, so the
    // parser never left `[core]` and credited the next indented line to it — a bogus sparse badge.
    // Git reports core.sparseCheckout as unset here.
    expect(
      parseCoreSparseCheckoutFlag(
        '[core]\n[core "sub"]worktreeConfig = x\n\tsparseCheckout = true\n'
      )
    ).toBeUndefined()
  })

  it('honors the last assignment across mixed same-line and indented forms', () => {
    expect(
      parseCoreSparseCheckoutFlag(
        '[core] sparseCheckout = true\n[core]\n\tsparseCheckout = false\n'
      )
    ).toBe(false)
    expect(
      parseCoreSparseCheckoutFlag(
        '[core]\n\tsparseCheckout = false\n[core] sparseCheckout = true\n'
      )
    ).toBe(true)
  })

  it('handles comments and whitespace around a same-line header', () => {
    expect(parseCoreSparseCheckoutFlag('[core]# c\n\tsparseCheckout = true\n')).toBe(true)
    expect(parseCoreSparseCheckoutFlag('\t[core] sparseCheckout = true ; c\n')).toBe(true)
  })

  it('does not treat trailing junk as a second assignment', () => {
    // Git parses this line fine and takes the whole tail as one value (`git config --list` reports
    // `core.sparsecheckout=true bogus = false`) — a value runs to end of line, so only one
    // assignment can share a line. Git then fails the boolean coercion outright, so reading the
    // whole tail as the value keeps us on the conservative "not sparse" side.
    expect(parseCoreSparseCheckoutFlag('[core] sparseCheckout = true bogus = false\n')).toBe(false)
  })
})
