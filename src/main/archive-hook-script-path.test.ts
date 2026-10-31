import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Repo } from '../shared/repo-types'

const REPO_FIELDS = {
  id: 'r',
  displayName: 'r',
  badgeColor: '#000',
  addedAt: 0
} as const

// #26257: orca.yaml is read from the main checkout, then the archive command runs with cwd set to
// the worktree being removed. A relative script that exists only on main must still be found.
describe.skipIf(process.platform === 'win32')('archive hook script path', () => {
  it('runs a relative archive script from the checkout that supplied orca.yaml', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-archive-hook-path-'))
    const main = join(root, 'main')
    const worktree = join(root, 'old-branch')
    mkdirSync(join(main, 'scripts'), { recursive: true })
    mkdirSync(worktree)
    writeFileSync(
      join(main, 'orca.yaml'),
      'scripts:\n  archive: bash scripts/worktree-archive.sh\n'
    )
    writeFileSync(join(main, 'scripts', 'worktree-archive.sh'), 'echo ARCHIVED_FROM_MAIN\n')
    chmodSync(join(main, 'scripts', 'worktree-archive.sh'), 0o755)
    const repo: Repo = { ...REPO_FIELDS, path: main }
    try {
      const { runHook } = await import('./hooks')
      const result = await runHook('archive', worktree, repo)
      expect(result.success).toBe(true)
      expect(result.output).toContain('ARCHIVED_FROM_MAIN')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps the worktree copy when that relative script exists there', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-archive-hook-path-'))
    const main = join(root, 'main')
    const worktree = join(root, 'old-branch')
    mkdirSync(join(main, 'scripts'), { recursive: true })
    mkdirSync(join(worktree, 'scripts'), { recursive: true })
    writeFileSync(
      join(main, 'orca.yaml'),
      'scripts:\n  archive: bash scripts/worktree-archive.sh\n'
    )
    writeFileSync(join(main, 'scripts', 'worktree-archive.sh'), 'echo FROM_MAIN\n')
    writeFileSync(join(worktree, 'scripts', 'worktree-archive.sh'), 'echo FROM_WORKTREE\n')
    const repo: Repo = { ...REPO_FIELDS, path: main }
    try {
      const { runHook } = await import('./hooks')
      const result = await runHook('archive', worktree, repo)
      expect(result.success).toBe(true)
      expect(result.output).toContain('FROM_WORKTREE')
      expect(result.output).not.toContain('FROM_MAIN')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not retarget a setup script onto the main checkout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-archive-hook-path-'))
    const main = join(root, 'main')
    const worktree = join(root, 'old-branch')
    mkdirSync(join(main, 'scripts'), { recursive: true })
    mkdirSync(worktree)
    writeFileSync(join(main, 'orca.yaml'), 'scripts:\n  setup: bash scripts/worktree-archive.sh\n')
    writeFileSync(join(main, 'scripts', 'worktree-archive.sh'), 'echo FROM_MAIN\n')
    const repo: Repo = { ...REPO_FIELDS, path: main }
    try {
      const { runHook } = await import('./hooks')
      const result = await runHook('setup', worktree, repo)
      expect(result.success).toBe(false)
      expect(result.exitCode).toBe(127)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
