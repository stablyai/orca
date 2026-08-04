// Phase 8 §0.2/A0 — promotion correctness against a REAL Git binary.
//
// The decisive test in this file is 10b, the LEAK PROOF: it asserts that a drift
// mismatch adds ZERO objects to the real store. That is the property the
// re-derive-into-the-real-store design could not provide, and the reason Phase 8
// promotes an already-approved graph instead.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deriveCandidateTree } from './audited-candidate-identity'
import {
  getCandidateStoreDir,
  measureCandidateFootprint,
  promoteApprovedGraph
} from './audited-candidate-object-store'
import { createTestRepo, git, type TestRepo } from './audited-worktree-test-repo'

const SECRET = 'UNAPPROVED-SECRET-c0ffee'

function realObjectFiles(repoPath: string): string[] {
  const root = join(repoPath, '.git', 'objects')
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else {
        found.push(full)
      }
    }
  }
  walk(root)
  return found.sort()
}

/** True when ANY object in the real store contains the marker bytes. */
function anyRealObjectContains(repoPath: string, marker: string): boolean {
  for (const file of realObjectFiles(repoPath)) {
    // Loose objects are zlib-compressed, so the raw bytes will not match; ask Git
    // to inflate each one instead.
    const rel = file.split(/[\\/]/).slice(-2)
    const oid = `${rel[0]}${rel[1]}`
    if (!/^[0-9a-f]{40}$/.test(oid)) {
      continue
    }
    try {
      const content = execFileSync('git', ['cat-file', '-p', oid], {
        cwd: repoPath,
        encoding: 'utf8',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
      })
      if (content.includes(marker)) {
        return true
      }
    } catch {
      // Not an inflatable blob/tree/commit; nothing to inspect.
    }
  }
  return false
}

describe('audited commit promotion', () => {
  let repo: TestRepo
  let userDataPath: string

  beforeEach(() => {
    repo = createTestRepo()
    writeFileSync(join(repo.repoPath, 'tracked.txt'), 'original\n')
    git(repo.repoPath, ['add', 'tracked.txt'])
    git(repo.repoPath, ['commit', '-q', '-m', 'add tracked'])
    repo.headCommit = git(repo.repoPath, ['rev-parse', 'HEAD'])
    userDataPath = join(repo.workspaceRoot, 'userdata')
    mkdirSync(userDataPath, { recursive: true })
  })

  afterEach(() => {
    repo.cleanup()
  })

  async function deriveDurable(candidateId: string): Promise<string> {
    const storeDir = getCandidateStoreDir(userDataPath, candidateId)
    mkdirSync(storeDir, { recursive: true })
    const result = await deriveCandidateTree({
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
    if (!result.ok) {
      throw new Error(`derivation failed: ${result.reasonCode}`)
    }
    return result.treeOid
  }

  // 10a — the regression guard proving A0 cannot be dropped.
  it('an ephemeral candidate leaves the approved tree ABSENT from the real store', async () => {
    writeFileSync(join(repo.repoPath, 'tracked.txt'), 'changed\n')
    const derived = await deriveCandidateTree({
      runId: `exec_${'1'.repeat(16)}`,
      userDataPath,
      worktreePath: repo.repoPath,
      sourceRepoPath: repo.repoPath,
      baseCommit: repo.headCommit,
      wslDistro: null,
      hostId: 'local',
      retention: 'ephemeral'
    })
    expect(derived.ok).toBe(true)
    const treeOid = derived.ok ? derived.treeOid : ''

    // Without promotion, commit-tree cannot resolve the tree at all.
    expect(() => execFileSync('git', ['cat-file', '-e', treeOid], { cwd: repo.repoPath })).toThrow()
  })

  // 10b — THE LEAK PROOF.
  it('a drift mismatch adds ZERO objects to the real store and leaks no secret', async () => {
    writeFileSync(join(repo.repoPath, 'tracked.txt'), 'approved change\n')
    const candidateId = `cand_${'a'.repeat(32)}`
    const approvedTree = await deriveDurable(candidateId)

    // Now DRIFT the worktree with a distinctive secret plus a new untracked file.
    const before = realObjectFiles(repo.repoPath)
    writeFileSync(join(repo.repoPath, 'tracked.txt'), `approved change\n${SECRET}\n`)
    writeFileSync(join(repo.repoPath, 'leak.txt'), `${SECRET}\n`)

    // A0.1 runs in a THROWAWAY store; this is what the gate compares.
    const recheck = await deriveCandidateTree({
      runId: `exec_${'2'.repeat(16)}`,
      userDataPath,
      worktreePath: repo.repoPath,
      sourceRepoPath: repo.repoPath,
      baseCommit: repo.headCommit,
      wslDistro: null,
      hostId: 'local',
      retention: 'ephemeral'
    })
    expect(recheck.ok).toBe(true)
    const recomputed = recheck.ok ? recheck.treeOid : ''

    // The gate refuses: mismatch, so promotion never runs.
    expect(recomputed).not.toBe(approvedTree)

    // THE ASSERTIONS THAT MATTER: nothing was persisted.
    expect(realObjectFiles(repo.repoPath)).toEqual(before)
    expect(anyRealObjectContains(repo.repoPath, SECRET)).toBe(false)
  })

  // 10c — promotion is graph-only, never worktree-derived.
  it('promotes only the approved graph even when the worktree has drifted', async () => {
    writeFileSync(join(repo.repoPath, 'tracked.txt'), 'approved change\n')
    const candidateId = `cand_${'b'.repeat(32)}`
    const approvedTree = await deriveDurable(candidateId)

    // Drift AFTER capture. Promotion must ignore these bytes entirely.
    writeFileSync(join(repo.repoPath, 'tracked.txt'), `approved change\n${SECRET}\n`)
    writeFileSync(join(repo.repoPath, 'leak.txt'), `${SECRET}\n`)

    const before = realObjectFiles(repo.repoPath).length
    const promoted = await promoteApprovedGraph({
      candidateStoreDir: join(getCandidateStoreDir(userDataPath, candidateId), 'objects'),
      worktreePath: repo.repoPath,
      approvedTreeOid: approvedTree
    })
    expect(promoted.ok).toBe(true)

    // The tree now resolves...
    execFileSync('git', ['cat-file', '-e', approvedTree], { cwd: repo.repoPath })
    // ...and the drifted bytes are nowhere in the real store.
    expect(anyRealObjectContains(repo.repoPath, SECRET)).toBe(false)
    expect(realObjectFiles(repo.repoPath).length).toBeGreaterThan(before)
  })

  // 10e — promotion is idempotent.
  it('re-promoting the same graph succeeds and adds nothing', async () => {
    writeFileSync(join(repo.repoPath, 'tracked.txt'), 'approved change\n')
    const candidateId = `cand_${'c'.repeat(32)}`
    const approvedTree = await deriveDurable(candidateId)
    const storeObjects = join(getCandidateStoreDir(userDataPath, candidateId), 'objects')

    const first = await promoteApprovedGraph({
      candidateStoreDir: storeObjects,
      worktreePath: repo.repoPath,
      approvedTreeOid: approvedTree
    })
    expect(first.ok).toBe(true)
    const afterFirst = realObjectFiles(repo.repoPath)

    const second = await promoteApprovedGraph({
      candidateStoreDir: storeObjects,
      worktreePath: repo.repoPath,
      approvedTreeOid: approvedTree
    })
    expect(second.ok).toBe(true)
    expect(realObjectFiles(repo.repoPath)).toEqual(afterFirst)
  })

  // 10f — a missing store fails closed, with NO re-hash fallback.
  it('fails closed when the candidate store is gone', async () => {
    writeFileSync(join(repo.repoPath, 'tracked.txt'), 'approved change\n')
    const candidateId = `cand_${'d'.repeat(32)}`
    const approvedTree = await deriveDurable(candidateId)

    rmSync(getCandidateStoreDir(userDataPath, candidateId), { recursive: true, force: true })
    const before = realObjectFiles(repo.repoPath)

    const promoted = await promoteApprovedGraph({
      candidateStoreDir: join(getCandidateStoreDir(userDataPath, candidateId), 'objects'),
      worktreePath: repo.repoPath,
      approvedTreeOid: approvedTree
    })
    expect(promoted.ok).toBe(false)
    if (!promoted.ok) {
      expect(promoted.reasonCode).toBe('candidate_objects_unavailable')
    }
    // Crucially: no fallback re-hashed the worktree into the real store.
    expect(realObjectFiles(repo.repoPath)).toEqual(before)
  })

  // 10b(2) — durable retention keeps objects; ephemeral does not.
  it('durable retention keeps the store while ephemeral removes it', async () => {
    writeFileSync(join(repo.repoPath, 'tracked.txt'), 'approved change\n')
    const candidateId = `cand_${'e'.repeat(32)}`
    await deriveDurable(candidateId)
    const storeDir = getCandidateStoreDir(userDataPath, candidateId)
    expect(existsSync(join(storeDir, 'objects'))).toBe(true)
    // The temp index is still cleaned up even for a durable derivation.
    expect(existsSync(join(storeDir, 'index.tmp'))).toBe(false)
  })

  // 10g11 — logical and durable byte counts are distinct measurements.
  it('measures logical and durable bytes separately', async () => {
    // Highly compressible content: logical bytes far exceed on-disk bytes.
    writeFileSync(join(repo.repoPath, 'big.txt'), 'A'.repeat(200_000))
    const candidateId = `cand_${'f'.repeat(32)}`
    const treeOid = await deriveDurable(candidateId)

    const measured = await measureCandidateFootprint(
      join(getCandidateStoreDir(userDataPath, candidateId), 'objects'),
      repo.repoPath,
      treeOid
    )
    expect(measured.ok).toBe(true)
    if (measured.ok) {
      expect(measured.footprint.logicalBytes).toBeGreaterThan(200_000)
      // zlib collapses the repeated bytes, so the two are NOT interchangeable.
      expect(measured.footprint.durableBytes).toBeLessThan(measured.footprint.logicalBytes)
    }
  })

  it('keeps the real index untouched during a durable derivation', async () => {
    writeFileSync(join(repo.repoPath, 'tracked.txt'), 'approved change\n')
    const indexPath = join(repo.repoPath, '.git', 'index')
    const before = readFileSync(indexPath)
    await deriveDurable(`cand_${'9'.repeat(32)}`)
    expect(readFileSync(indexPath).equals(before)).toBe(true)
  })
})
