// Phase 8 Phases A/B/C/D against a REAL Git binary.
//
// Proves the properties that make the crash windows recoverable:
//   - after A the object exists, the ref is STILL AT BASE, and status is unchanged
//   - the three-operand update-ref CAS refuses a moved branch
//   - Phase C is genuinely required (without it `git status` lies)
//   - Phase D detects a mid-protocol edit WITHOUT failing the durable commit
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deriveCandidateTree } from './audited-candidate-identity'
import { getCandidateStoreDir, promoteApprovedGraph } from './audited-candidate-object-store'
import { canonicalizeCommitMessage } from './audited-commit-message'
import {
  runCommitTree,
  runIndexRefresh,
  runRefUpdateCas,
  readBranchTip
} from './audited-commit-git'
import { verifyWorktreeAfterCommit } from './audited-commit-post-verify'
import { createTestRepo, git, type TestRepo } from './audited-worktree-test-repo'

function status(repoPath: string): string {
  return execFileSync('git', ['status', '--porcelain'], {
    cwd: repoPath,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  }).trim()
}

describe('audited commit two-phase protocol', () => {
  let repo: TestRepo
  let userDataPath: string
  let branchName: string

  beforeEach(() => {
    repo = createTestRepo()
    writeFileSync(join(repo.repoPath, 'tracked.txt'), 'original\n')
    git(repo.repoPath, ['add', 'tracked.txt'])
    git(repo.repoPath, ['commit', '-q', '-m', 'add tracked'])
    repo.headCommit = git(repo.repoPath, ['rev-parse', 'HEAD'])
    branchName = git(repo.repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])
    userDataPath = join(repo.workspaceRoot, 'userdata')
    mkdirSync(userDataPath, { recursive: true })
  })

  afterEach(() => {
    repo.cleanup()
  })

  async function prepareCandidate(candidateId: string): Promise<string> {
    const storeDir = getCandidateStoreDir(userDataPath, candidateId)
    mkdirSync(storeDir, { recursive: true })
    const derived = await deriveCandidateTree({
      runId: `exec_${'0'.repeat(16)}`,
      userDataPath,
      worktreePath: repo.repoPath,
      sourceRepoPath: repo.repoPath,
      baseCommit: repo.headCommit,
      wslDistro: null,
      hostId: 'local',
      retention: 'durable',
      durableStoreDir: storeDir
    })
    if (!derived.ok) {
      throw new Error(`derive failed: ${derived.reasonCode}`)
    }
    const promoted = await promoteApprovedGraph({
      candidateStoreDir: join(storeDir, 'objects'),
      worktreePath: repo.repoPath,
      approvedTreeOid: derived.treeOid
    })
    if (!promoted.ok) {
      throw new Error(`promote failed: ${promoted.reasonCode}`)
    }
    return derived.treeOid
  }

  it('leaves the ref at base and status unchanged after Phase A', async () => {
    writeFileSync(join(repo.repoPath, 'tracked.txt'), 'changed\n')
    const treeOid = await prepareCandidate(`cand_${'1'.repeat(32)}`)
    const statusBefore = status(repo.repoPath)

    const created = await runCommitTree({
      userDataPath,
      attemptId: 'catt_1',
      worktreePath: repo.repoPath,
      treeOid,
      parentOid: repo.headCommit,
      message: 'subject\n'
    })

    expect(created.ok).toBe(true)
    // The object exists...
    if (created.ok) {
      execFileSync('git', ['cat-file', '-e', created.commitSha], { cwd: repo.repoPath })
    }
    // ...but the ref never moved and the worktree is untouched.
    expect(await readBranchTip(repo.repoPath, branchName)).toBe(repo.headCommit)
    expect(status(repo.repoPath)).toBe(statusBefore)
  })

  it('refuses the CAS when the branch moved under us', async () => {
    writeFileSync(join(repo.repoPath, 'tracked.txt'), 'changed\n')
    const treeOid = await prepareCandidate(`cand_${'2'.repeat(32)}`)
    const created = await runCommitTree({
      userDataPath,
      attemptId: 'catt_2',
      worktreePath: repo.repoPath,
      treeOid,
      parentOid: repo.headCommit,
      message: 'subject\n'
    })
    expect(created.ok).toBe(true)
    if (!created.ok) {
      return
    }

    // Move the branch behind our back.
    writeFileSync(join(repo.repoPath, 'other.txt'), 'other\n')
    git(repo.repoPath, ['add', 'other.txt'])
    git(repo.repoPath, ['commit', '-q', '-m', 'sneaky'])
    const moved = git(repo.repoPath, ['rev-parse', 'HEAD'])
    expect(moved).not.toBe(repo.headCommit)

    const result = await runRefUpdateCas({
      worktreePath: repo.repoPath,
      branchName,
      newCommitSha: created.commitSha,
      expectedOldSha: repo.headCommit
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reasonCode).toBe('branch_ref_moved')
    }
    // The sneaky commit is still the tip: our CAS changed nothing.
    expect(await readBranchTip(repo.repoPath, branchName)).toBe(moved)
  })

  it('needs Phase C to leave a clean status after the ref update', async () => {
    writeFileSync(join(repo.repoPath, 'tracked.txt'), 'changed\n')
    writeFileSync(join(repo.repoPath, 'untracked.txt'), 'new file\n')
    const treeOid = await prepareCandidate(`cand_${'3'.repeat(32)}`)
    const created = await runCommitTree({
      userDataPath,
      attemptId: 'catt_3',
      worktreePath: repo.repoPath,
      treeOid,
      parentOid: repo.headCommit,
      message: 'subject\n'
    })
    expect(created.ok).toBe(true)
    if (!created.ok) {
      return
    }

    expect(
      (
        await runRefUpdateCas({
          worktreePath: repo.repoPath,
          branchName,
          newCommitSha: created.commitSha,
          expectedOldSha: repo.headCommit
        })
      ).ok
    ).toBe(true)

    // WITHOUT Phase C the index is stale and status reports spurious entries.
    expect(status(repo.repoPath)).not.toBe('')

    expect(await runIndexRefresh(repo.repoPath)).toBe(true)
    expect(status(repo.repoPath)).toBe('')

    // Both files survive byte-intact — Phase C is index-only.
    expect(
      execFileSync('git', ['show', 'HEAD:untracked.txt'], {
        cwd: repo.repoPath,
        encoding: 'utf8'
      })
    ).toBe('new file\n')
  })

  // 14a — the deterministic mid-protocol edit.
  it('records post-commit drift as an ADVISORY without failing the commit', async () => {
    writeFileSync(join(repo.repoPath, 'tracked.txt'), 'approved\n')
    const treeOid = await prepareCandidate(`cand_${'4'.repeat(32)}`)
    const created = await runCommitTree({
      userDataPath,
      attemptId: 'catt_4',
      worktreePath: repo.repoPath,
      treeOid,
      parentOid: repo.headCommit,
      message: 'subject\n'
    })
    expect(created.ok).toBe(true)
    if (!created.ok) {
      return
    }

    expect(
      (
        await runRefUpdateCas({
          worktreePath: repo.repoPath,
          branchName,
          newCommitSha: created.commitSha,
          expectedOldSha: repo.headCommit
        })
      ).ok
    ).toBe(true)
    await runIndexRefresh(repo.repoPath)

    // THE SEAM: a tracked file changes after the ref moved. No sleeps, no timing.
    writeFileSync(join(repo.repoPath, 'tracked.txt'), 'approved\nEDITED AFTER COMMIT\n')

    const verification = await verifyWorktreeAfterCommit({
      attemptId: 'catt_4',
      userDataPath,
      worktreePath: repo.repoPath,
      sourceRepoPath: repo.repoPath,
      branchName,
      committedSha: created.commitSha,
      committedTreeOid: treeOid,
      wslDistro: null,
      hostId: 'local'
    })

    // Drift is detected...
    expect(verification.advisory).toBe('post_commit_drift_detected')
    // ...and the commit remains durable and correct: the ref still points at it,
    // and it still records the APPROVED tree, not the edit.
    expect(await readBranchTip(repo.repoPath, branchName)).toBe(created.commitSha)
    expect(git(repo.repoPath, ['rev-parse', `${created.commitSha}^{tree}`])).toBe(treeOid)
  })

  it('records no advisory for a clean run', async () => {
    writeFileSync(join(repo.repoPath, 'tracked.txt'), 'approved\n')
    const treeOid = await prepareCandidate(`cand_${'5'.repeat(32)}`)
    const created = await runCommitTree({
      userDataPath,
      attemptId: 'catt_5',
      worktreePath: repo.repoPath,
      treeOid,
      parentOid: repo.headCommit,
      message: 'subject\n'
    })
    expect(created.ok).toBe(true)
    if (!created.ok) {
      return
    }

    await runRefUpdateCas({
      worktreePath: repo.repoPath,
      branchName,
      newCommitSha: created.commitSha,
      expectedOldSha: repo.headCommit
    })
    await runIndexRefresh(repo.repoPath)

    const verification = await verifyWorktreeAfterCommit({
      attemptId: 'catt_5',
      userDataPath,
      worktreePath: repo.repoPath,
      sourceRepoPath: repo.repoPath,
      branchName,
      committedSha: created.commitSha,
      committedTreeOid: treeOid,
      wslDistro: null,
      hostId: 'local'
    })
    expect(verification.advisory).toBeNull()
  })

  it('commits the canonical message body', async () => {
    writeFileSync(join(repo.repoPath, 'tracked.txt'), 'approved\n')
    const treeOid = await prepareCandidate(`cand_${'6'.repeat(32)}`)
    const canonical = canonicalizeCommitMessage('Subject line\r\n\r\nBody text')
    expect(canonical.ok).toBe(true)
    if (!canonical.ok) {
      return
    }

    const created = await runCommitTree({
      userDataPath,
      attemptId: 'catt_6',
      worktreePath: repo.repoPath,
      treeOid,
      parentOid: repo.headCommit,
      message: canonical.text
    })
    expect(created.ok).toBe(true)
    if (!created.ok) {
      return
    }

    const body = git(repo.repoPath, ['log', '-1', '--format=%B', created.commitSha])
    expect(body).toContain('Subject line')
    expect(body).toContain('Body text')
    // CRLF was normalized, so the commit is byte-identical across platforms.
    expect(body).not.toContain('\r')
  })
})
