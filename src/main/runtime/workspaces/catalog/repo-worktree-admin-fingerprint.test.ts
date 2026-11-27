import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readRepoWorktreeAdminFingerprint } from './repo-worktree-admin-fingerprint'

let tempDir = ''

function makeTempDir(): string {
  tempDir = mkdtempSync(path.join(tmpdir(), 'orca-admin-fp-'))
  return tempDir
}

function git(cwd: string, ...args: string[]): void {
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args],
    {
      cwd,
      stdio: 'ignore'
    }
  )
}

// Reftable needs git >= 2.45; older CI images skip rather than fail.
const supportsReftable = (() => {
  const probeDir = mkdtempSync(path.join(tmpdir(), 'orca-reftable-probe-'))
  try {
    git(probeDir, 'init', '-q', '--ref-format=reftable')
    return true
  } catch {
    return false
  } finally {
    rmSync(probeDir, { recursive: true, force: true })
  }
})()

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true })
    tempDir = ''
  }
})

describe('repo worktree admin fingerprint', () => {
  it('reads per-worktree refs from the linked worktree admin directory', async () => {
    const repoDir = path.join(makeTempDir(), 'repo')
    const linkedAdminDir = path.join(repoDir, '.git', 'worktrees', 'wt-a')
    mkdirSync(path.join(linkedAdminDir, 'refs', 'worktree'), { recursive: true })
    mkdirSync(path.join(tempDir, 'wt-a'))
    writeFileSync(path.join(repoDir, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    writeFileSync(path.join(linkedAdminDir, 'gitdir'), `${path.join(tempDir, 'wt-a', '.git')}\n`)
    writeFileSync(path.join(linkedAdminDir, 'HEAD'), 'ref: refs/worktree/custom\n')
    const customRef = path.join(linkedAdminDir, 'refs', 'worktree', 'custom')
    writeFileSync(customRef, `${'a'.repeat(40)}\n`)

    const before = await readRepoWorktreeAdminFingerprint(repoDir)
    writeFileSync(customRef, `${'b'.repeat(40)}\n`)
    const after = await readRepoWorktreeAdminFingerprint(repoDir)

    expect(before).not.toBeNull()
    expect(after).not.toBe(before)
  })

  it.skipIf(!supportsReftable)(
    'detects a linked worktree HEAD move in a reftable repo',
    async () => {
      const repoDir = path.join(makeTempDir(), 'repo')
      const linkedDir = path.join(tempDir, 'wt')
      git(tempDir, 'init', '-q', '--ref-format=reftable', '-b', 'main', repoDir)
      git(repoDir, 'commit', '-q', '--allow-empty', '-m', 'init')
      git(repoDir, 'branch', 'feature')
      git(repoDir, 'worktree', 'add', '-q', linkedDir, 'feature')

      const before = await readRepoWorktreeAdminFingerprint(repoDir)
      // Only the linked worktree's own reftable stack changes; its HEAD file stays a fixed stub.
      git(linkedDir, 'checkout', '-q', '--detach')
      const after = await readRepoWorktreeAdminFingerprint(repoDir)

      expect(before).not.toBeNull()
      expect(after).not.toBe(before)
    }
  )
})
