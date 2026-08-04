// Phase 9 lease safety against a REAL Git binary and a REAL bare remote.
//
// These are the decisive proofs of the publish safety model:
//   - an explicit lease pushes when the remote is where we believe it is
//   - a STALE lease is rejected and the remote is left BYTE-IDENTICAL
//   - the empty lease creates a branch but refuses to overwrite a colliding one
//   - ls-remote reports a missing ref as exit 0 with EMPTY stdout, which is why
//     absence is read from output and never from the exit code
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runLeasedPush } from './audited-publish-git'
import { probeRemoteRef, resolvePublishRemote } from './audited-publish-remote'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  }).trim()
}

function lsRemoteRaw(repoPath: string, ref: string): string {
  return git(repoPath, ['ls-remote', 'origin', ref])
}

describe('publish lease safety (real git, real remote)', () => {
  let root: string
  let remotePath: string
  let repoPath: string
  let otherPath: string
  let branch: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-publish-'))
    remotePath = join(root, 'remote.git')
    repoPath = join(root, 'work')
    otherPath = join(root, 'other')
    branch = 'feature'

    execFileSync('git', ['init', '-q', '--bare', remotePath], { encoding: 'utf8' })
    execFileSync('git', ['init', '-q', '-b', branch, repoPath], { encoding: 'utf8' })
    git(repoPath, ['config', 'user.email', 'test@example.com'])
    git(repoPath, ['config', 'user.name', 'Test'])
    git(repoPath, ['config', 'commit.gpgsign', 'false'])
    writeFileSync(join(repoPath, 'a.txt'), 'one\n')
    git(repoPath, ['add', '.'])
    git(repoPath, ['commit', '-q', '-m', 'first'])
    git(repoPath, ['remote', 'add', 'origin', remotePath])
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function commitMore(message: string): string {
    writeFileSync(join(repoPath, 'a.txt'), `${message}\n`)
    git(repoPath, ['add', '.'])
    git(repoPath, ['commit', '-q', '-m', message])
    return git(repoPath, ['rev-parse', 'HEAD'])
  }

  it('probes a MISSING remote ref as absent, not as a failure', async () => {
    // The classification-critical case: ls-remote exits 0 with empty stdout.
    const probe = await probeRemoteRef(repoPath, 'origin', branch)
    expect(probe).toEqual({ ok: true, sha: null })
  })

  it('creates the branch with the empty (create-only) lease', async () => {
    const sha = git(repoPath, ['rev-parse', 'HEAD'])
    const result = await runLeasedPush({
      worktreePath: repoPath,
      remote: 'origin',
      branchName: branch,
      sha,
      expectedRemoteSha: null
    })
    expect(result.ok).toBe(true)

    const probe = await probeRemoteRef(repoPath, 'origin', branch)
    expect(probe).toEqual({ ok: true, sha })
  })

  it('pushes when the explicit lease matches the remote', async () => {
    const first = git(repoPath, ['rev-parse', 'HEAD'])
    await runLeasedPush({
      worktreePath: repoPath,
      remote: 'origin',
      branchName: branch,
      sha: first,
      expectedRemoteSha: null
    })

    const second = commitMore('second')
    const result = await runLeasedPush({
      worktreePath: repoPath,
      remote: 'origin',
      branchName: branch,
      sha: second,
      expectedRemoteSha: first
    })
    expect(result.ok).toBe(true)
    expect((await probeRemoteRef(repoPath, 'origin', branch)).ok).toBe(true)
    expect(lsRemoteRaw(repoPath, `refs/heads/${branch}`)).toContain(second)
  })

  it('REFUSES a stale lease and leaves the remote byte-identical', async () => {
    const first = git(repoPath, ['rev-parse', 'HEAD'])
    await runLeasedPush({
      worktreePath: repoPath,
      remote: 'origin',
      branchName: branch,
      sha: first,
      expectedRemoteSha: null
    })

    // A third party moves the remote branch.
    execFileSync('git', ['clone', '-q', remotePath, otherPath], { encoding: 'utf8' })
    git(otherPath, ['config', 'user.email', 'other@example.com'])
    git(otherPath, ['config', 'user.name', 'Other'])
    git(otherPath, ['config', 'commit.gpgsign', 'false'])
    git(otherPath, ['checkout', '-q', branch])
    writeFileSync(join(otherPath, 'a.txt'), 'third-party\n')
    git(otherPath, ['add', '.'])
    git(otherPath, ['commit', '-q', '-m', 'third party'])
    git(otherPath, ['push', '-q', 'origin', branch])

    const beforeAttempt = lsRemoteRaw(repoPath, `refs/heads/${branch}`)

    // We still believe the remote is at `first` — a stale lease.
    const mine = commitMore('mine')
    const result = await runLeasedPush({
      worktreePath: repoPath,
      remote: 'origin',
      branchName: branch,
      sha: mine,
      expectedRemoteSha: first
    })

    expect(result).toEqual({ ok: false, reasonCode: 'push_rejected_stale_lease' })
    // THE PROOF: nothing on the remote changed.
    expect(lsRemoteRaw(repoPath, `refs/heads/${branch}`)).toBe(beforeAttempt)
    expect(beforeAttempt).not.toContain(mine)
  })

  it('REFUSES an empty lease when a different branch already exists remotely', async () => {
    // Someone else creates the branch first.
    execFileSync('git', ['clone', '-q', remotePath, otherPath], { encoding: 'utf8' })
    git(otherPath, ['config', 'user.email', 'other@example.com'])
    git(otherPath, ['config', 'user.name', 'Other'])
    git(otherPath, ['config', 'commit.gpgsign', 'false'])
    writeFileSync(join(otherPath, 'x.txt'), 'theirs\n')
    git(otherPath, ['add', '.'])
    git(otherPath, ['commit', '-q', '-m', 'theirs'])
    git(otherPath, ['branch', '-M', branch])
    git(otherPath, ['push', '-q', 'origin', branch])

    const beforeAttempt = lsRemoteRaw(repoPath, `refs/heads/${branch}`)
    expect(beforeAttempt).not.toBe('')

    const mine = git(repoPath, ['rev-parse', 'HEAD'])
    const result = await runLeasedPush({
      worktreePath: repoPath,
      remote: 'origin',
      branchName: branch,
      sha: mine,
      // We believed it was absent.
      expectedRemoteSha: null
    })

    expect(result.ok).toBe(false)
    expect(lsRemoteRaw(repoPath, `refs/heads/${branch}`)).toBe(beforeAttempt)
  })

  it('resolves origin as the publish remote', async () => {
    await expect(resolvePublishRemote(repoPath, branch)).resolves.toEqual({
      ok: true,
      remote: 'origin'
    })
  })

  it('refuses truthfully when no remote is configured', async () => {
    git(repoPath, ['remote', 'remove', 'origin'])
    await expect(resolvePublishRemote(repoPath, branch)).resolves.toEqual({
      ok: false,
      reasonCode: 'no_remote_configured'
    })
  })

  it('reports an unreachable remote as unreadable, never as absent', async () => {
    git(repoPath, ['remote', 'set-url', 'origin', join(root, 'does-not-exist.git')])
    const probe = await probeRemoteRef(repoPath, 'origin', branch)
    expect(probe).toEqual({ ok: false, reasonCode: 'remote_ref_unreadable' })
  })
})
