import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import * as path from 'path'
import { detectGitButlerWorkspace } from './gitbutler-detection'

// Real temp dirs: the module probes the filesystem with existsSync/readFile, so
// we exercise the actual common-dir derivation rather than injecting a result.
describe('detectGitButlerWorkspace', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'gitbutler-detect-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  // A plain (non-linked) checkout: resolveGitDir returns the .git dir directly,
  // which is also the common dir.
  function makePlainGitDir(gitDirName = '.git'): {
    gitDir: string
    resolveGitDir: () => Promise<string>
  } {
    const gitDir = path.join(root, gitDirName)
    return { gitDir, resolveGitDir: async () => gitDir }
  }

  it('(a) workspace branch + common-dir gitbutler/ present → true', async () => {
    const { gitDir, resolveGitDir } = makePlainGitDir()
    await mkdir(path.join(gitDir, 'gitbutler'), { recursive: true })

    expect(await detectGitButlerWorkspace(root, 'gitbutler/workspace', resolveGitDir)).toBe(true)
  })

  it('(a) accepts a refs/heads/-prefixed workspace branch', async () => {
    const { gitDir, resolveGitDir } = makePlainGitDir()
    await mkdir(path.join(gitDir, 'gitbutler'), { recursive: true })

    expect(
      await detectGitButlerWorkspace(root, 'refs/heads/gitbutler/workspace', resolveGitDir)
    ).toBe(true)
  })

  it('(b) workspace branch, no metadata → false', async () => {
    const { gitDir, resolveGitDir } = makePlainGitDir()
    await mkdir(gitDir, { recursive: true })

    expect(await detectGitButlerWorkspace(root, 'gitbutler/workspace', resolveGitDir)).toBe(false)
  })

  it('(c) normal branch + metadata present → false', async () => {
    const { gitDir, resolveGitDir } = makePlainGitDir()
    await mkdir(path.join(gitDir, 'gitbutler'), { recursive: true })

    expect(await detectGitButlerWorkspace(root, 'main', resolveGitDir)).toBe(false)
  })

  it('(d) normal repo (no metadata) → false', async () => {
    const { gitDir, resolveGitDir } = makePlainGitDir()
    await mkdir(gitDir, { recursive: true })

    expect(await detectGitButlerWorkspace(root, 'main', resolveGitDir)).toBe(false)
  })

  it('treats a regular file named gitbutler as not-managed (metadata must be a dir)', async () => {
    const { gitDir, resolveGitDir } = makePlainGitDir()
    await mkdir(gitDir, { recursive: true })
    await writeFile(path.join(gitDir, 'gitbutler'), 'not a metadata dir\n', 'utf-8')

    expect(await detectGitButlerWorkspace(root, 'gitbutler/workspace', resolveGitDir)).toBe(false)
  })

  it('(e) legacy gitbutler/integration branch + metadata → true', async () => {
    const { gitDir, resolveGitDir } = makePlainGitDir()
    await mkdir(path.join(gitDir, 'gitbutler'), { recursive: true })

    expect(await detectGitButlerWorkspace(root, 'gitbutler/integration', resolveGitDir)).toBe(true)
  })

  it('returns false for a null/undefined branch', async () => {
    const { gitDir, resolveGitDir } = makePlainGitDir()
    await mkdir(path.join(gitDir, 'gitbutler'), { recursive: true })

    expect(await detectGitButlerWorkspace(root, null, resolveGitDir)).toBe(false)
    expect(await detectGitButlerWorkspace(root, undefined, resolveGitDir)).toBe(false)
  })

  it('does no git-dir resolution on a normal branch (gate before any fs work)', async () => {
    // Why: detection runs on the status hot path; the branch-name gate must
    // short-circuit before resolveGitDir so normal repos pay zero fs cost.
    const resolveGitDir = vi.fn(async () => path.join(root, '.git'))

    expect(await detectGitButlerWorkspace(root, 'main', resolveGitDir)).toBe(false)
    expect(resolveGitDir).not.toHaveBeenCalled()
  })

  describe('linked worktree (per-worktree dir resolves the common dir via commondir)', () => {
    // Mirrors git's layout: the common git dir holds `gitbutler/`, and the
    // linked worktree's per-worktree dir holds a `commondir` file pointing
    // (relatively) at the common dir.
    async function makeLinkedWorktree(withMetadata: boolean): Promise<{
      perWorktreeDir: string
      resolveGitDir: () => Promise<string>
    }> {
      const commonGitDir = path.join(root, 'common', '.git')
      const perWorktreeDir = path.join(commonGitDir, 'worktrees', 'feature')
      await mkdir(perWorktreeDir, { recursive: true })
      await mkdir(withMetadata ? path.join(commonGitDir, 'gitbutler') : commonGitDir, {
        recursive: true
      })
      // git writes the common dir as a relative path (e.g. ../..) inside commondir.
      const relativeCommonDir = path.relative(perWorktreeDir, commonGitDir)
      await writeFile(path.join(perWorktreeDir, 'commondir'), `${relativeCommonDir}\n`, 'utf-8')
      return { perWorktreeDir, resolveGitDir: async () => perWorktreeDir }
    }

    it('(f) workspace branch + common-dir gitbutler/ → true', async () => {
      const { resolveGitDir } = await makeLinkedWorktree(true)

      expect(await detectGitButlerWorkspace(root, 'gitbutler/workspace', resolveGitDir)).toBe(true)
    })

    it('(f) negative: linked worktree on a normal branch → false', async () => {
      const { resolveGitDir } = await makeLinkedWorktree(true)

      expect(await detectGitButlerWorkspace(root, 'main', resolveGitDir)).toBe(false)
    })

    it('linked worktree, workspace branch, no metadata → false', async () => {
      const { resolveGitDir } = await makeLinkedWorktree(false)

      expect(await detectGitButlerWorkspace(root, 'gitbutler/workspace', resolveGitDir)).toBe(false)
    })

    it('resolves an absolute commondir path (git may write one) → true', async () => {
      const commonGitDir = path.join(root, 'common', '.git')
      const perWorktreeDir = path.join(commonGitDir, 'worktrees', 'feature')
      await mkdir(path.join(commonGitDir, 'gitbutler'), { recursive: true })
      await mkdir(perWorktreeDir, { recursive: true })
      // Absolute path variant of commondir (git writes relative by default).
      await writeFile(path.join(perWorktreeDir, 'commondir'), `${commonGitDir}\n`, 'utf-8')

      expect(
        await detectGitButlerWorkspace(root, 'gitbutler/workspace', async () => perWorktreeDir)
      ).toBe(true)
    })
  })
})
