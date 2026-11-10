import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CloudTransferManifest } from '../../shared/hosted-sandbox/cloud-transfer-pack'
import {
  applyPatchIdempotent,
  applyTransferToWorktree,
  conflictPathsFromGitApply,
  loadPersistedTransfer,
  persistTransfer
} from './cloud-transfer-apply'
import { sweepCloudTransfers } from './cloud-transfer'

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    encoding: 'utf8'
  })

/** A repo whose worktree has `a.txt` and `b.txt` committed, plus a patch that edits both. */
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'orca-reapply-'))
  const repo = join(root, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-q')
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  writeFileSync(join(repo, 'b.txt'), 'two\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'base')
  writeFileSync(join(repo, 'a.txt'), 'one cloud\n')
  writeFileSync(join(repo, 'b.txt'), 'two cloud\n')
  const dir = join(root, 'transfer')
  mkdirSync(dir)
  writeFileSync(join(dir, 'unstaged.patch'), git(repo, 'diff', '--binary'))
  writeFileSync(join(dir, 'staged.patch'), '')
  git(repo, 'checkout', '--', '.')
  const manifest: CloudTransferManifest = {
    version: 1,
    root: '/vercel/sandbox/project',
    branch: 'main',
    head: null,
    upstream: null,
    hasBundle: true,
    stagedBytes: 0,
    unstagedBytes: 1,
    untrackedFiles: 0,
    claudeSessions: 0,
    codexSessions: 0
  }
  const entry = { dir, manifest, repoPath: repo, workspaceId: 'ws-1' }
  const homes = { claudeHome: join(root, 'claude'), codexHome: join(root, 'codex') }
  return { root, repo, dir, entry, homes }
}

describe('Apply changes again', () => {
  it('is idempotent: a second apply recognises the patch is already there', async () => {
    const { repo, entry, homes, dir } = setup()
    const first = await applyTransferToWorktree(entry, repo, homes)
    expect(first.appliedUnstaged).toBe(true)
    expect(first.leftoverPatchDir).toBeNull()
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('one cloud\n')
    // A retry against the same worktree (e.g. a lost reply) must not fail or double-apply.
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'unstaged.patch'), git(repo, 'diff', '--binary'))
    writeFileSync(join(dir, 'staged.patch'), '')
    const again = await applyTransferToWorktree(entry, repo, homes)
    expect(again.appliedUnstaged).toBe(true)
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('one cloud\n')
  })

  it('never forces a patch over local edits: keeps it, reports the files, then applies once they are resolved', async () => {
    const { repo, entry, homes, dir } = setup()
    writeFileSync(join(repo, 'b.txt'), 'two edited here\n')
    const first = await applyTransferToWorktree(entry, repo, homes)
    expect(first.appliedUnstaged).toBe(false)
    expect(first.leftoverPatchDir).toBe(join(dir, 'unapplied'))
    expect(first.conflicts).toContain('b.txt')
    // Nothing was half-applied: a.txt is untouched and the user's edit is intact.
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('one\n')
    expect(readFileSync(join(repo, 'b.txt'), 'utf8')).toBe('two edited here\n')
    // The user puts b.txt back; Apply changes again now succeeds and clears the saved copy.
    git(repo, 'checkout', '--', 'b.txt')
    const again = await applyTransferToWorktree(entry, repo, homes)
    expect(again.appliedUnstaged).toBe(true)
    expect(again.leftoverPatchDir).toBeNull()
    expect(existsSync(dir)).toBe(false)
    expect(readFileSync(join(repo, 'b.txt'), 'utf8')).toBe('two cloud\n')
  })

  it('reports none for an empty patch and parses git apply conflict paths', async () => {
    const { repo, dir } = setup()
    expect((await applyPatchIdempotent(repo, join(dir, 'staged.patch'), true, join(dir, 'u'))).outcome).toBe('none')
    expect(
      conflictPathsFromGitApply('error: patch failed: src/x.ts:12\nerror: src/x.ts: patch does not apply\nerror: gone.txt: does not exist in working directory\n')
    ).toEqual(['src/x.ts', 'gone.txt'])
  })

  it('survives an app restart: the transfer folder records itself, and the sweep keeps an attempted apply', async () => {
    const { root, repo, entry } = setup()
    await persistTransfer(entry, repo)
    const loaded = await loadPersistedTransfer(entry.dir)
    expect(loaded).toMatchObject({ dir: entry.dir, repoPath: repo, workspaceId: 'ws-1' })
    expect(await sweepCloudTransfers(root, Date.now())).toBe(1) // the bare repo dir goes, transfer stays
    expect(existsSync(entry.dir)).toBe(true)
    expect(await loadPersistedTransfer(join(root, 'nope'))).toBeNull()
  })
})
