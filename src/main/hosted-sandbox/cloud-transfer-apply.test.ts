import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
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
import { listPendingCloudTransfers, sweepCloudTransfers } from './cloud-transfer'

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
    expect(
      (await applyPatchIdempotent(repo, join(dir, 'staged.patch'), true, join(dir, 'u'))).outcome
    ).toBe('none')
    expect(
      conflictPathsFromGitApply(
        'error: patch failed: src/x.ts:12\nerror: src/x.ts: patch does not apply\nerror: gone.txt: does not exist in working directory\n'
      )
    ).toEqual(['src/x.ts', 'gone.txt'])
  })

  it('survives an app restart: the transfer folder records itself, and the sweep keeps an attempted apply', async () => {
    const { root, repo, entry } = setup()
    await persistTransfer(entry, repo)
    const loaded = await loadPersistedTransfer(entry.dir)
    expect(loaded).toMatchObject({ dir: entry.dir, repoPath: repo, workspaceId: 'ws-1' })
    const at = statSync(join(entry.dir, 'transfer.json')).mtimeMs + 1_000
    expect(await sweepCloudTransfers(root, at)).toBe(1) // the bare repo dir goes, transfer stays
    expect(existsSync(entry.dir)).toBe(true)
    expect(await loadPersistedTransfer(join(root, 'nope'))).toBeNull()
  })

  it('re-applies safely when staged and unstaged changes touch the same file', async () => {
    const { repo, dir, entry, homes } = setup()
    // Cloud side: a.txt staged as "one staged", then edited further (unstaged) to "one staged + more".
    writeFileSync(join(repo, 'a.txt'), 'one staged\n')
    git(repo, 'add', 'a.txt')
    writeFileSync(join(dir, 'staged.patch'), git(repo, 'diff', '--cached', '--binary'))
    writeFileSync(join(repo, 'a.txt'), 'one staged\nmore\n')
    writeFileSync(join(dir, 'unstaged.patch'), git(repo, 'diff', '--binary'))
    git(repo, 'reset', '-q', '--hard')
    const first = await applyTransferToWorktree(entry, repo, homes)
    expect(first).toMatchObject({
      appliedStaged: true,
      appliedUnstaged: true,
      leftoverPatchDir: null
    })
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('one staged\nmore\n')
    // A retry (lost reply, or "Apply changes again") must recognise both as already there.
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'staged.patch'), git(repo, 'diff', '--cached', '--binary'))
    writeFileSync(join(dir, 'unstaged.patch'), git(repo, 'diff', '--binary'))
    const again = await applyTransferToWorktree(entry, repo, homes)
    expect(again).toMatchObject({
      appliedStaged: true,
      appliedUnstaged: true,
      leftoverPatchDir: null,
      conflicts: []
    })
    expect(git(repo, 'diff', '--cached', '--name-only').trim()).toBe('a.txt')
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('one staged\nmore\n')
  })

  it('keeps untracked files it could not write (a different file is here) and names them', async () => {
    const { root, repo, dir, entry, homes } = setup()
    const src = join(root, 'untracked-src')
    mkdirSync(join(src, 'notes'), { recursive: true })
    writeFileSync(join(src, 'notes', 'todo.md'), 'cloud todo\n')
    writeFileSync(join(src, 'new.txt'), 'cloud new\n')
    execFileSync('tar', ['-czf', join(dir, 'untracked.tgz'), '-C', src, 'notes', 'new.txt'], {
      env: { ...process.env, COPYFILE_DISABLE: '1' }
    })
    mkdirSync(join(repo, 'notes'))
    writeFileSync(join(repo, 'notes', 'todo.md'), 'my local todo\n')
    const result = await applyTransferToWorktree(entry, repo, homes)
    expect(readFileSync(join(repo, 'notes', 'todo.md'), 'utf8')).toBe('my local todo\n')
    expect(readFileSync(join(repo, 'new.txt'), 'utf8')).toBe('cloud new\n')
    expect(result.skippedUntracked).toEqual(['notes/todo.md'])
    expect(result.leftoverPatchDir).toBe(join(dir, 'unapplied'))
    expect(readFileSync(join(dir, 'unapplied', 'untracked-not-written.txt'), 'utf8')).toBe(
      'notes/todo.md\n'
    )
    expect(existsSync(join(dir, 'unapplied', 'untracked.tgz'))).toBe(true)
    // No temp files left behind next to the written ones.
    expect(execFileSync('ls', ['-A', join(repo, 'notes')], { encoding: 'utf8' }).trim()).toBe(
      'todo.md'
    )
    // Once the local file is moved aside, Apply changes again writes it; identical files count as done.
    writeFileSync(join(repo, 'notes', 'todo.md'), 'cloud todo\n')
    const again = await applyTransferToWorktree(entry, repo, homes)
    expect(again.skippedUntracked).toEqual([])
    expect(again.leftoverPatchDir).toBeNull()
  })

  it('lists transfers left part-applied, for the after-restart offer', async () => {
    const { root, repo, entry } = setup()
    const transfers = join(root, 'transfers')
    const id = '11111111-2222-3333-4444-555555555555'
    const dir = join(transfers, id)
    mkdirSync(dir, { recursive: true })
    await persistTransfer({ ...entry, dir }, repo)
    mkdirSync(join(transfers, 'not-a-transfer'))
    expect(await listPendingCloudTransfers(transfers)).toEqual([
      {
        transferId: id,
        workspaceId: 'ws-1',
        worktreePath: repo,
        leftoverDir: join(dir, 'unapplied')
      }
    ])
  })
})
