import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWorktreePreparationLockReason } from '../../../../shared/worktree/create-preparation'
import { addWorktreeWithCopyOnWriteCheckout } from './worktree-copy-on-write-add'
import { prepareWorktreeCreateCheckout } from './worktree-create-preparation'

const tempRoots: string[] = []
// Clones keep extended attributes; files Git writes have none.
const CLONE_MARKER = 'com.orca.clone-marker'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
}

function hasCloneMarker(path: string): boolean {
  try {
    execFileSync('xattr', ['-p', CLONE_MARKER, path], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

/** A main checkout on `main`, one commit ahead of `base`, with an uncommitted edit. */
async function createRepo(): Promise<{ repoPath: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'orca-cow-worktree-'))
  tempRoots.push(root)
  const repoPath = join(root, 'repo')
  execFileSync('git', ['init', '--quiet', repoPath])
  git(repoPath, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(repoPath, ['config', 'user.email', 'test@example.com'])
  git(repoPath, ['config', 'user.name', 'Test User'])
  await writeFile(join(repoPath, 'shared.txt'), 'shared\n')
  await writeFile(join(repoPath, 'edited.txt'), 'committed\n')
  git(repoPath, ['add', '.'])
  git(repoPath, ['commit', '--quiet', '-m', 'base'])
  git(repoPath, ['branch', 'base'])
  await writeFile(join(repoPath, 'main-only.txt'), 'main\n')
  git(repoPath, ['add', '.'])
  git(repoPath, ['commit', '--quiet', '-m', 'main only'])
  await writeFile(join(repoPath, 'edited.txt'), 'uncommitted\n')
  execFileSync('xattr', ['-w', CLONE_MARKER, '1', join(repoPath, 'shared.txt')])
  return { repoPath, root }
}

async function expectExactBaseCheckout(worktreePath: string): Promise<void> {
  expect(hasCloneMarker(join(worktreePath, 'shared.txt'))).toBe(true)
  expect(await readFile(join(worktreePath, 'edited.txt'), 'utf8')).toBe('committed\n')
  expect(existsSync(join(worktreePath, 'main-only.txt'))).toBe(false)
  expect(git(worktreePath, ['status', '--porcelain', '--untracked-files=all'])).toBe('')
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe.runIf(process.platform === 'darwin')('copy-on-write worktree checkout', () => {
  it('clones into prepared worktrees', async () => {
    const { repoPath, root } = await createRepo()
    const preparedPath = join(root, 'prepared')

    await prepareWorktreeCreateCheckout(
      repoPath,
      preparedPath,
      'base',
      createWorktreePreparationLockReason('copy-on-write')
    )

    await expectExactBaseCheckout(preparedPath)
  })

  it('clones on direct creates and runs post-checkout as for a new worktree', async () => {
    const { repoPath, root } = await createRepo()
    const hookLog = join(root, 'post-checkout.log')
    const hook = join(repoPath, '.git', 'hooks', 'post-checkout')
    await writeFile(hook, `#!/bin/sh\necho "$1 $2 $3" >> "${hookLog}"\n`)
    await chmod(hook, 0o755)
    const worktreePath = join(root, 'feature')

    await addWorktreeWithCopyOnWriteCheckout(repoPath, worktreePath, 'feature', 'base', false)

    await expectExactBaseCheckout(worktreePath)
    const base = git(repoPath, ['rev-parse', 'base']).trim()
    expect(await readFile(hookLog, 'utf8')).toBe(`${'0'.repeat(40)} ${base} 1\n`)
  })

  it('leaves submodules unpopulated when submodule.recurse is set', async () => {
    const { repoPath, root } = await createRepo()
    const subPath = join(root, 'sub')
    execFileSync('git', ['init', '--quiet', subPath])
    git(subPath, ['commit', '--quiet', '--allow-empty', '-m', 'sub', '--author', 'T <t@e.x>'])
    git(repoPath, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subPath, 'sub'])
    git(repoPath, ['commit', '--quiet', '-m', 'submodule'])
    git(repoPath, ['config', 'submodule.recurse', 'true'])
    const worktreePath = join(root, 'feature')

    await addWorktreeWithCopyOnWriteCheckout(repoPath, worktreePath, 'feature', 'main', false)

    expect(hasCloneMarker(join(worktreePath, 'shared.txt'))).toBe(true)
    expect(existsSync(join(worktreePath, 'sub', '.git'))).toBe(false)
  })

  it('lets Git write files that a checkout filter would change', async () => {
    const { repoPath, root } = await createRepo()
    git(repoPath, ['config', 'filter.tag.clean', "sed 's/^SMUDGE://'"])
    git(repoPath, ['config', 'filter.tag.smudge', "sed 's/^/SMUDGE:/'"])
    await writeFile(join(repoPath, '.gitattributes'), 'filtered.txt filter=tag\n')
    // Main holds unsmudged bytes that still clean to the committed blob, like an LFS pointer.
    await writeFile(join(repoPath, 'filtered.txt'), 'data\n')
    git(repoPath, ['add', '.'])
    git(repoPath, ['commit', '--quiet', '-m', 'filtered'])
    const worktreePath = join(root, 'feature')

    await addWorktreeWithCopyOnWriteCheckout(repoPath, worktreePath, 'feature', 'main', false)

    expect(await readFile(join(worktreePath, 'filtered.txt'), 'utf8')).toBe('SMUDGE:data\n')
    expect(hasCloneMarker(join(worktreePath, 'shared.txt'))).toBe(true)
  })

  it('gives clones the permissions and flags of a fresh checkout', async () => {
    const { repoPath, root } = await createRepo()
    for (const name of ['a-deleted.txt', 'locked.txt', 'read-only.txt']) {
      await writeFile(join(repoPath, name), `${name}\n`)
    }
    git(repoPath, ['add', '.'])
    git(repoPath, ['commit', '--quiet', '-m', 'more files'])
    // Sorts first, so it would have been the clone probe.
    await rm(join(repoPath, 'a-deleted.txt'))
    await chmod(join(repoPath, 'read-only.txt'), 0o444)
    execFileSync('chflags', ['uchg', join(repoPath, 'locked.txt')])
    const worktreePath = join(root, 'feature')

    try {
      await addWorktreeWithCopyOnWriteCheckout(repoPath, worktreePath, 'feature', 'main', false)

      const checkedOutMode = (await stat(join(worktreePath, 'edited.txt'))).mode
      expect((await stat(join(worktreePath, 'read-only.txt'))).mode).toBe(checkedOutMode)
      expect(
        execFileSync('stat', ['-f', '%f', join(worktreePath, 'locked.txt')], {
          encoding: 'utf8'
        }).trim()
      ).toBe('0')
      expect(hasCloneMarker(join(worktreePath, 'shared.txt'))).toBe(true)
      expect(git(worktreePath, ['status', '--porcelain', '--untracked-files=all'])).toBe('')
    } finally {
      execFileSync('chflags', ['-R', 'nouchg', root])
    }
  })
})
