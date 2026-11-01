import { describe, expect, it } from 'vitest'
import { getRepoHostIdentityForParts } from '../../../shared/repo-host-identity'
import { WorkspaceGitIdentity, type ScannedIdentityRow } from './workspace-git-identity'

const REPO = getRepoHostIdentityForParts('repo-1', 'local')
const SCANNED = new Set([REPO])
const base = {
  id: 'repo-1::/r/a',
  repoId: 'repo-1',
  hostId: 'local',
  instanceId: 'i-1',
  branch: 'refs/heads/a',
  displayName: 'a',
  displayNameMode: 'automatic',
  linkedPR: 7
} as const

/** A row from a scan that ran git (a new run) or answered from the scan cache (`run` reused). */
function row(
  overrides: Partial<ScannedIdentityRow> = {},
  run: ScannedIdentityRow['gitRun'] = {}
): ScannedIdentityRow {
  return { ...base, gitRun: run, ...overrides }
}

describe('WorkspaceGitIdentity', () => {
  it('clears branch-scoped links on a branch switch it saw, never on the first sight', () => {
    const identity = new WorkspaceGitIdentity()
    expect(identity.observeScan([row({ branch: 'refs/heads/z' })], SCANNED)).toEqual([])
    const clears = identity.observeScan([row()], SCANNED)
    expect(clears).toEqual([
      {
        target: { id: base.id, hostId: 'local' },
        updates: expect.objectContaining({ linkedPR: null, linkedGitLabMR: null })
      }
    ])
    // The cleared links are what the next scan expects; the same branch clears nothing.
    expect(identity.observeScan([row({ linkedPR: null })], SCANNED)).toEqual([])
  })

  it('keeps a link written after the last scan, which may belong to the new branch', () => {
    const identity = new WorkspaceGitIdentity()
    identity.observeScan([row({ linkedPR: null })], SCANNED)
    expect(identity.observeScan([row({ branch: 'refs/heads/b', linkedPR: 9 })], SCANNED)).toEqual(
      []
    )
  })

  it('keeps a PR linked on a new branch that a cached rescan still reported as the old one', () => {
    const identity = new WorkspaceGitIdentity()
    const cachedRun = {}
    identity.observeScan([row({ linkedPR: null }, cachedRun)], SCANNED)
    // checkout -b b, then the PR is linked; the rescan answers from the scan cache (branch a).
    identity.observeScan([row({ linkedPR: 9 }, cachedRun)], SCANNED)
    // Git runs again and sees branch b: the PR belongs to it.
    expect(identity.observeScan([row({ branch: 'refs/heads/b', linkedPR: 9 })], SCANNED)).toEqual(
      []
    )
  })

  it('records a link once git ran again on the same branch, so a later switch clears it', () => {
    const identity = new WorkspaceGitIdentity()
    identity.observeScan([row({ linkedPR: null })], SCANNED)
    identity.observeScan([row({ linkedPR: 9 })], SCANNED)
    expect(
      identity.observeScan([row({ branch: 'refs/heads/b', linkedPR: 9 })], SCANNED)
    ).toHaveLength(1)
  })

  it('treats a recreated workspace, or one with no instance id, as new', () => {
    const identity = new WorkspaceGitIdentity()
    identity.observeScan([row()], SCANNED)
    expect(
      identity.observeScan([row({ instanceId: 'i-2', branch: 'refs/heads/b' })], SCANNED)
    ).toEqual([])
    const unstamped = new WorkspaceGitIdentity()
    unstamped.observeScan([row({ instanceId: undefined })], SCANNED)
    expect(
      unstamped.observeScan([row({ instanceId: undefined, branch: 'refs/heads/b' })], SCANNED)
    ).toEqual([])
  })

  it('keeps the same id on another host apart', () => {
    const identity = new WorkspaceGitIdentity()
    identity.observeScan([row()], SCANNED)
    expect(
      identity.observeScan([row({ hostId: 'ssh:box', branch: 'refs/heads/b' })], SCANNED)
    ).toEqual([])
  })

  it('forgets a row its repo stopped listing, but not one whose repo scan stalled', () => {
    const identity = new WorkspaceGitIdentity()
    identity.observeScan([row()], SCANNED)
    // The repo's scan stalled: nothing is known, so the row is kept.
    identity.observeScan([], new Set())
    expect(identity.observeScan([row({ branch: 'refs/heads/b' })], SCANNED)).toHaveLength(1)
    // The repo listed without it: gone, so its return under the same instance is a first sight.
    identity.observeScan([], SCANNED)
    expect(identity.observeScan([row({ branch: 'refs/heads/c' })], SCANNED)).toEqual([])
  })

  it('keeps an automatic title through a detached head, and follows the next branch', () => {
    const identity = new WorkspaceGitIdentity()
    identity.observeScan([row({ linkedPR: null })], SCANNED)
    const detached = row({ branch: '', displayName: 'r', linkedPR: null })
    identity.observeScan([detached], SCANNED)
    expect(identity.title(detached)).toBe('a')
    const next = row({ branch: 'refs/heads/c', displayName: 'c', linkedPR: null })
    identity.observeScan([next], SCANNED)
    expect(identity.title(next)).toBe('c')
    expect(identity.title({ ...detached, displayNameMode: 'fixed' })).toBe('r')
  })
})
