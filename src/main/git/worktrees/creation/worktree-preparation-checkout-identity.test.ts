import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWorktreePreparationLockReason } from '../../../../shared/worktree/creation/create-preparation'
import { lockWorktreePreparation } from './worktree-preparation-lock'
import { performDiscardPreparedWorktree } from './worktree-preparation-discard'

describe('prepared checkout identity guard when .git is missing', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true })
    }
  })

  async function setupPreparedWorktree() {
    const root = await mkdtemp(join(tmpdir(), 'orca-prep-identity-'))
    tempDirs.push(root)
    const repo = join(root, 'repo')
    await mkdir(repo)
    execFileSync('git', ['init'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
    await writeFile(join(repo, 'README.md'), 'init\n')
    execFileSync('git', ['add', 'README.md'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo })

    const prepared = join(
      root,
      '.orca-preparing',
      `${process.pid}-11111111-1111-4111-8111-111111111111`
    )
    await mkdir(join(root, '.orca-preparing'), { recursive: true })
    execFileSync('git', ['worktree', 'add', '--detach', prepared], { cwd: repo })
    const reason = createWorktreePreparationLockReason('session-1')
    await lockWorktreePreparation(prepared, reason, {})
    return { repo, prepared, reason }
  }

  it('refuses to erase a replacement directory containing user files', async () => {
    const { repo, prepared, reason } = await setupPreparedWorktree()
    await rm(prepared, { recursive: true, force: true })
    await mkdir(prepared, { recursive: true })
    await writeFile(join(prepared, 'user-notes.txt'), 'do not delete\n')

    await expect(performDiscardPreparedWorktree(repo, prepared, {}, reason)).rejects.toThrow()
    expect(await readFile(join(prepared, 'user-notes.txt'), 'utf8')).toBe('do not delete\n')
    await expect(readFile(join(prepared, '.git'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('still reclaims the original prepared directory when only its .git file was deleted', async () => {
    const { repo, prepared, reason } = await setupPreparedWorktree()
    await writeFile(join(prepared, 'partial.txt'), 'partial\n')
    await rm(join(prepared, '.git'))

    await expect(performDiscardPreparedWorktree(repo, prepared, {}, reason)).resolves.toBe(
      'removed'
    )
    await expect(readFile(join(prepared, 'partial.txt'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })
})
