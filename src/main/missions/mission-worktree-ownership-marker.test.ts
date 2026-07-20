import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertMissionWorktreeOwnershipMarker,
  hasMissionWorktreeOwnershipMarker,
  readMissionWorktreeOwnershipMarker,
  type MissionWorktreeOwnershipProof,
  writeMissionWorktreeOwnershipMarker
} from './mission-worktree-ownership-marker'

const tempRoots: string[] = []

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

function createCommittedRepo(): { repoPath: string; rootPath: string } {
  const rootPath = mkdtempSync(path.join(tmpdir(), 'orca-mission-owner-marker-'))
  tempRoots.push(rootPath)
  const repoPath = path.join(rootPath, 'repo')
  execFileSync('git', ['init', '--quiet', repoPath])
  git(repoPath, ['config', 'user.name', 'Orca Test'])
  git(repoPath, ['config', 'user.email', 'orca@example.com'])
  git(repoPath, ['commit', '--quiet', '--allow-empty', '-m', 'initial'])
  return { repoPath: realpathSync(repoPath), rootPath }
}

function createCommittedBareRepo(): { repoPath: string; rootPath: string } {
  const rootPath = mkdtempSync(path.join(tmpdir(), 'orca-mission-owner-marker-bare-'))
  tempRoots.push(rootPath)
  const seedPath = path.join(rootPath, 'seed')
  const repoPath = path.join(rootPath, 'repo.git')
  execFileSync('git', ['init', '--quiet', seedPath])
  git(seedPath, ['config', 'user.name', 'Orca Test'])
  git(seedPath, ['config', 'user.email', 'orca@example.com'])
  git(seedPath, ['commit', '--quiet', '--allow-empty', '-m', 'initial'])
  execFileSync('git', ['clone', '--bare', '--quiet', seedPath, repoPath])
  return { repoPath: realpathSync(repoPath), rootPath }
}

function addWorktree(repoPath: string, worktreePath: string, branchName: string): string {
  git(repoPath, ['worktree', 'add', '--quiet', '-b', branchName, worktreePath, 'HEAD'])
  return realpathSync(worktreePath)
}

function createProof(worktreePath: string): MissionWorktreeOwnershipProof {
  return {
    missionId: 'mission-1',
    repoId: 'repo-1',
    worktreeId: `repo-1::${worktreePath}`,
    worktreeInstanceId: 'instance-1'
  }
}

afterEach(() => {
  for (const rootPath of tempRoots.splice(0)) {
    rmSync(rootPath, { recursive: true, force: true })
  }
})

describe('Mission worktree ownership marker Git integration', () => {
  it('rejects a replacement checkout re-added at the same path and branch', () => {
    const { repoPath, rootPath } = createCommittedRepo()
    const requestedWorktreePath = path.join(rootPath, 'member')
    const worktreePath = addWorktree(repoPath, requestedWorktreePath, 'mission/task')
    const proof = createProof(worktreePath)

    writeMissionWorktreeOwnershipMarker({ repoPath, worktreePath, proof })
    expect(hasMissionWorktreeOwnershipMarker({ repoPath, worktreePath, proof })).toBe(true)
    expect(readMissionWorktreeOwnershipMarker({ repoPath, worktreePath })).toEqual(proof)

    // Why: Git removes the per-checkout admin directory that owns the marker;
    // reusing both visible identifiers must not revive the old Mission proof.
    git(repoPath, ['worktree', 'remove', '--force', worktreePath])
    git(repoPath, ['worktree', 'add', '--quiet', worktreePath, 'mission/task'])
    expect(git(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('mission/task')

    expect(() => assertMissionWorktreeOwnershipMarker({ repoPath, worktreePath, proof })).toThrow(
      'mission_member_worktree_ownership_unverified'
    )
    expect(hasMissionWorktreeOwnershipMarker({ repoPath, worktreePath, proof })).toBe(false)
  })

  it('returns null for a registered linked worktree without an ownership marker', () => {
    const { repoPath, rootPath } = createCommittedRepo()
    const worktreePath = addWorktree(repoPath, path.join(rootPath, 'ordinary'), 'ordinary/task')

    expect(readMissionWorktreeOwnershipMarker({ repoPath, worktreePath })).toBeNull()
  })

  it('rejects an ownership marker with an empty durable identity field', () => {
    const { repoPath, rootPath } = createCommittedRepo()
    const worktreePath = addWorktree(repoPath, path.join(rootPath, 'member'), 'mission/empty-id')
    const proof = createProof(worktreePath)
    writeMissionWorktreeOwnershipMarker({ repoPath, worktreePath, proof })
    const gitDir = path.resolve(worktreePath, git(worktreePath, ['rev-parse', '--git-dir']))
    writeFileSync(
      path.join(gitDir, 'orca-mission-owner.json'),
      JSON.stringify({
        version: 1,
        missionId: proof.missionId,
        repoId: proof.repoId,
        worktreeId: proof.worktreeId,
        instanceId: ''
      })
    )

    expect(() => readMissionWorktreeOwnershipMarker({ repoPath, worktreePath })).toThrow(
      'mission_member_worktree_ownership_unverified'
    )
  })

  it('resolves the common Git directory when repoPath is itself a linked worktree', () => {
    const { repoPath, rootPath } = createCommittedRepo()
    const contextPath = addWorktree(
      repoPath,
      path.join(rootPath, 'linked-repo-context'),
      'fixture/context'
    )
    const worktreePath = addWorktree(
      contextPath,
      path.join(rootPath, 'mission-member'),
      'mission/from-linked-context'
    )
    const proof = createProof(worktreePath)

    writeMissionWorktreeOwnershipMarker({ repoPath: contextPath, worktreePath, proof })

    expect(() =>
      assertMissionWorktreeOwnershipMarker({ repoPath: contextPath, worktreePath, proof })
    ).not.toThrow()
  })

  it('resolves a bare repository as the linked worktree common Git directory', () => {
    const { repoPath, rootPath } = createCommittedBareRepo()
    const worktreePath = addWorktree(
      repoPath,
      path.join(rootPath, 'bare-mission-member'),
      'mission/from-bare'
    )
    const proof = createProof(worktreePath)

    writeMissionWorktreeOwnershipMarker({ repoPath, worktreePath, proof })

    expect(() =>
      assertMissionWorktreeOwnershipMarker({ repoPath, worktreePath, proof })
    ).not.toThrow()
  })

  it.skipIf(process.platform !== 'win32')(
    'accepts Windows casing variants for the same Git admin paths',
    () => {
      const { repoPath, rootPath } = createCommittedRepo()
      const worktreePath = addWorktree(repoPath, path.join(rootPath, 'member'), 'mission/windows')
      const proof = createProof(worktreePath)

      writeMissionWorktreeOwnershipMarker({
        repoPath: repoPath.toUpperCase(),
        worktreePath,
        proof
      })

      expect(() =>
        assertMissionWorktreeOwnershipMarker({
          repoPath,
          worktreePath: worktreePath.toUpperCase(),
          proof
        })
      ).not.toThrow()
    }
  )
})
