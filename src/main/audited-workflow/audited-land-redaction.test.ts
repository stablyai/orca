// What the landing lane may NEVER project (Phase 10).
//
// THE HIGHEST-RISK PATH IN THE FEATURE. Every other lane operates inside the
// managed worktree, whose location Orca chose. This one names the user's OWN
// repository — so the source repo path, its common dir, and the full landed /
// base SHAs must never cross the IPC boundary in any form.
import { describe, expect, it } from 'vitest'
import {
  AUDITED_PROJECTION_FORBIDDEN_KEYS,
  buildAuditedTaskProjection,
  shortenCandidateId,
  type ProjectionSourceTask
} from '../../shared/audited-workflow-projection'
// The renderer-side copy is asserted in
// renderer/src/components/audited-workflow/audited-landing-error-messages.test.ts —
// importing it here would cross a tsconfig project boundary.

const LANDED = 'c'.repeat(40)
const BASE = 'b'.repeat(40)
const SOURCE_PATH = '/home/alice/secret-project'
const COMMON_DIR = '/home/alice/secret-project/.git'

function source(overrides: Partial<ProjectionSourceTask> = {}): ProjectionSourceTask {
  return {
    taskId: 't',
    repoId: 'r',
    title: 'Task',
    state: 'landed',
    activePhase: null,
    risk: 'low',
    source: 'custom',
    triageDecision: null,
    triageRunStatus: null,
    triageBlockedReasonCode: null,
    planRound: 0,
    fixRound: 0,
    lastVerdict: null,
    blockedReasonCode: null,
    approvalState: 'none',
    approvalExpiresAt: null,
    auditApprovedTreeOid: null,
    committedSha: LANDED,
    commitAttemptStatus: 'completed',
    commitReasonCode: null,
    commitAdvisoryCode: null,
    publishAttemptStatus: 'completed',
    publishedSha: LANDED,
    publishReasonCode: null,
    publishAdvisoryCode: null,
    reviewProvider: null,
    reviewNumber: null,
    commitAttemptPublishable: true,
    landAttemptStatus: 'completed',
    landedSha: LANDED,
    landingReasonCode: 'landed',
    landingAdvisoryCode: 'worktree_update_failed',
    publishAttemptLandable: true,
    landHostSupported: true,
    auditApprovedForCurrentCandidate: false,
    approvalPendingAndValid: false,
    reconcileClass: null,
    reconcileReasonCode: null,
    worktreeProvenance: null,
    worktreeVerifiedAt: null,
    worktreeReasonCode: null,
    executionRunStatus: null,
    executionReasonCode: null,
    executionOutputTruncated: false,
    planArtifactId: null,
    planArtifactStatus: null,
    planArtifactTruncated: false,
    planArtifactRedactionCount: 0,
    planReviewRunStatus: null,
    planReviewVerdict: null,
    planReviewReasonCode: null,
    planReviewSummary: null,
    planReviewFindingCount: null,
    planReviewApprovedForCurrentArtifact: false,
    coverageAvailable: false,
    candidateStatus: null,
    codeAuditRunStatus: null,
    codeAuditVerdict: null,
    codeAuditReasonCode: null,
    codeAuditSummary: null,
    codeAuditFindingCount: null,
    fixRoundLimit: 3,
    acceptanceCriteria: [],
    timings: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

describe('the landing projection carries no identity', () => {
  it('shortens the landed sha and never carries the full form', () => {
    const projection = buildAuditedTaskProjection(source())
    expect(projection.landedShaShort).toBe(shortenCandidateId(LANDED))
    expect(projection.landedShaShort).toHaveLength(12)
    const serialized = JSON.stringify(projection)
    expect(serialized).not.toContain(LANDED)
    expect(serialized).not.toContain(BASE)
  })

  it('never carries the source repo path or its common dir', () => {
    const serialized = JSON.stringify(buildAuditedTaskProjection(source()))
    expect(serialized).not.toContain(SOURCE_PATH)
    expect(serialized).not.toContain(COMMON_DIR)
    expect(serialized).not.toContain('secret-project')
  })

  it('declares the Phase 10 identity fields forbidden', () => {
    expect(AUDITED_PROJECTION_FORBIDDEN_KEYS).toEqual(
      expect.arrayContaining([
        'landedSha',
        'landedBaseSha',
        'intendedBaseSha',
        'sourceRepoPath',
        'sourceRepoCommonDir',
        'landAttemptId',
        'landStderr'
      ])
    )
  })

  it('exposes no forbidden key at runtime', () => {
    const projection = buildAuditedTaskProjection(source()) as Record<string, unknown>
    for (const key of AUDITED_PROJECTION_FORBIDDEN_KEYS) {
      expect(projection).not.toHaveProperty(key)
    }
  })

  it('keeps the reason code and the advisory in SEPARATE fields', () => {
    // A durable land carrying a worktree caveat must not read as a failed land.
    const projection = buildAuditedTaskProjection(source())
    expect(projection.landingReasonCode).toBe('landed')
    expect(projection.landingAdvisoryCode).toBe('worktree_update_failed')
  })
})
