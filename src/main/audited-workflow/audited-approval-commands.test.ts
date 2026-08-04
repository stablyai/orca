// Phase 8 — approval authority, binding, expiry, and revocation.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { APPROVAL_TTL_DURATIONS_MS } from '../../shared/audited-commit-types'
import { createAuditedWorkflowTables } from './audited-task-schema'
import { grantApproval, revokeApproval } from './audited-approval-commands'
import {
  getPendingApproval,
  hasValidPendingApproval,
  isAuditApprovedForCurrentCandidate,
  resolveApprovalState
} from './audited-approval-repository'
import Database from '../sqlite/sync-database'

const TREE = 'a'.repeat(40)
const BASE = 'b'.repeat(40)
const NOW = 1_000_000

function seed(
  db: Database.Database,
  options: {
    state?: string
    approvedTree?: string | null
    verdict?: string | null
    candidateTree?: string
    candidateStatus?: string
  } = {}
): void {
  db.prepare(
    `INSERT INTO audited_tasks
       (id, repo_id, source_repo_path, base_commit, host_id, title, spec_json, source,
        risk, state, branch_name, current_candidate_id, audit_approved_tree_oid,
        code_audit_verdict, created_at_ms, updated_at_ms)
     VALUES ('task1', 'repo1', '/repo', ?, 'local', 't', '{}', 'custom', 'low', ?, 'br',
             'cand_1', ?, ?, 1, 1)`
  ).run(
    BASE,
    options.state ?? 'awaiting_human_approval',
    options.approvedTree === undefined ? TREE : options.approvedTree,
    options.verdict === undefined ? 'approved' : options.verdict
  )
  db.prepare(
    `INSERT INTO audited_candidates
       (id, task_id, run_id, round, status, tree_oid, base_commit, branch_name, created_at_ms)
     VALUES ('cand_1', 'task1', 'run_1', 0, ?, ?, ?, 'br', 1)`
  ).run(options.candidateStatus ?? 'current', options.candidateTree ?? TREE, BASE)
}

describe('audited approval commands', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    createAuditedWorkflowTables(db)
  })

  afterEach(() => {
    db.close()
  })

  it('grants an approval bound to the audit-approved candidate', () => {
    seed(db)
    expect(grantApproval(db, 'task1', 'standard', NOW).ok).toBe(true)

    const approval = getPendingApproval(db, 'task1')
    expect(approval).not.toBeNull()
    expect(approval?.candidateId).toBe('cand_1')
    expect(approval?.approvedTreeOid).toBe(TREE)
    expect(approval?.expiresAt).toBe(NOW + APPROVAL_TTL_DURATIONS_MS.standard)
  })

  it('refuses when the code audit has not approved', () => {
    seed(db, { verdict: 'fixes_requested', approvedTree: null })
    const result = grantApproval(db, 'task1', 'standard', NOW)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reasonCode).toBe('no_audit_approved_candidate')
    }
  })

  it('refuses when the current candidate is not the approved one', () => {
    seed(db, { candidateTree: 'f'.repeat(40) })
    const result = grantApproval(db, 'task1', 'standard', NOW)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reasonCode).toBe('candidate_identity_changed')
    }
  })

  it('refuses outside awaiting_human_approval', () => {
    seed(db, { state: 'awaiting_code_audit' })
    const result = grantApproval(db, 'task1', 'standard', NOW)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reasonCode).toBe('not_awaiting_approval')
    }
  })

  it('makes a double approve a detectable no-op', () => {
    seed(db)
    expect(grantApproval(db, 'task1', 'standard', NOW).ok).toBe(true)
    const second = grantApproval(db, 'task1', 'standard', NOW)
    expect(second.ok).toBe(false)
    if (!second.ok) {
      expect(second.reasonCode).toBe('lock_contended')
    }
  })

  // Expiry is EVALUATED, never trusted from the stored state.
  it('reports an elapsed approval as expired even though the row still reads pending', () => {
    seed(db)
    grantApproval(db, 'task1', 'short', NOW)
    const approval = getPendingApproval(db, 'task1')
    expect(approval?.state).toBe('pending')

    const afterExpiry = NOW + APPROVAL_TTL_DURATIONS_MS.short + 1
    expect(resolveApprovalState(approval, afterExpiry)).toBe('expired')
    expect(hasValidPendingApproval(db, 'task1', afterExpiry)).toBe(false)
    expect(hasValidPendingApproval(db, 'task1', NOW + 1)).toBe(true)
  })

  it('revokes a pending approval and refuses a second revoke', () => {
    seed(db)
    grantApproval(db, 'task1', 'standard', NOW)
    expect(revokeApproval(db, 'task1', NOW).ok).toBe(true)

    const second = revokeApproval(db, 'task1', NOW)
    expect(second.ok).toBe(false)
    if (!second.ok) {
      expect(second.reasonCode).toBe('no_pending_approval')
    }
  })

  it('resolves audit approval for the current candidate by id AND tree', () => {
    seed(db)
    expect(isAuditApprovedForCurrentCandidate(db, 'task1')).toBe(true)

    db.prepare(`UPDATE audited_candidates SET tree_oid = ? WHERE id = 'cand_1'`).run('9'.repeat(40))
    expect(isAuditApprovedForCurrentCandidate(db, 'task1')).toBe(false)
  })

  it('does not treat a superseded candidate as approved', () => {
    seed(db, { candidateStatus: 'superseded' })
    expect(isAuditApprovedForCurrentCandidate(db, 'task1')).toBe(false)
  })
})
