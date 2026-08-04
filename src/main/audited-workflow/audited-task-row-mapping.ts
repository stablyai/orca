// Maps raw SQLite row objects to the domain AuditedTaskRow/transition shapes.
// Isolated from query logic so column-name drift is a one-file change.
import type {
  AuditedTaskActor,
  AuditedTaskSource,
  AuditedTaskState,
  AuditedTaskTransitionRecord,
  BlockReasonCode,
  ReviewVerdict,
  RiskLevel,
  TriageDecision,
  TriageReasonCode,
  TriageRunStatus
} from '../../shared/audited-workflow-types'
import type {
  WorktreeProvenanceKind,
  WorktreeReasonCode
} from '../../shared/audited-worktree-types'

export type AuditedTaskRow = {
  id: string
  repoId: string
  sourceRepoPath: string
  worktreeId: string | null
  worktreePath: string | null
  branchName: string | null
  baseCommit: string
  hostId: string
  wslDistro: string | null
  title: string
  specJson: string
  source: AuditedTaskSource
  roadmapEntryId: string | null
  risk: RiskLevel
  state: AuditedTaskState
  preBlockState: AuditedTaskState | null
  // Why: shared across every phase that can block a task — currently written
  // with either a BlockReasonCode (non-triage blocks) or a TriageReasonCode
  // (triage-originated blocks; see finalizeTriageRunInternal/recovery). No
  // DB CHECK constraint narrows it (unlike triage_blocked_reason_code),
  // because future phases add their own reason-code vocabularies to the
  // same column — so this type is the union of every vocabulary that is
  // ACTUALLY written here today, kept honest at every write site's own
  // typed literals rather than by a runtime check.
  blockedReasonCode: BlockReasonCode | TriageReasonCode | null
  blockedPhase: string | null
  activePhase: string | null
  activeLockBinding: string | null
  planRound: number
  fixRound: number
  auditApprovedTreeOid: string | null
  committedSha: string | null
  landedSha: string | null
  landedBaseSha: string | null
  landingReasonCode: string | null
  triageDecision: TriageDecision | null
  triageRunStatus: TriageRunStatus | null
  triageBlockedReasonCode: TriageReasonCode | null
  // Phase 3. worktreeProvenance is non-null only for an actually verified
  // worktree — never a migration marker.
  worktreeProvenance: WorktreeProvenanceKind | null
  worktreeProvisionedAt: number | null
  sourceRepoCommonDir: string | null
  worktreeReasonCode: WorktreeReasonCode | null
  worktreeVerifiedAt: number | null
  // Phase 5. currentPlanArtifactId points at the single 'current' artifact row;
  // lastVerdict is the durable home of the long-declared `lastVerdict`
  // projection field and uses the EXISTING ReviewVerdict vocabulary.
  currentPlanArtifactId: string | null
  lastVerdict: ReviewVerdict | null
  createdAt: number
  updatedAt: number
}

export function sqliteRowToTask(row: Record<string, unknown>): AuditedTaskRow {
  return {
    id: row.id as string,
    repoId: row.repo_id as string,
    sourceRepoPath: row.source_repo_path as string,
    worktreeId: (row.worktree_id as string | null) ?? null,
    worktreePath: (row.worktree_path as string | null) ?? null,
    branchName: (row.branch_name as string | null) ?? null,
    baseCommit: row.base_commit as string,
    hostId: row.host_id as string,
    wslDistro: (row.wsl_distro as string | null) ?? null,
    title: row.title as string,
    specJson: row.spec_json as string,
    source: row.source as AuditedTaskSource,
    roadmapEntryId: (row.roadmap_entry_id as string | null) ?? null,
    risk: row.risk as RiskLevel,
    state: row.state as AuditedTaskState,
    preBlockState: (row.pre_block_state as AuditedTaskState | null) ?? null,
    blockedReasonCode:
      (row.blocked_reason_code as BlockReasonCode | TriageReasonCode | null) ?? null,
    blockedPhase: (row.blocked_phase as string | null) ?? null,
    activePhase: (row.active_phase as string | null) ?? null,
    activeLockBinding: (row.active_lock_binding as string | null) ?? null,
    planRound: row.plan_round as number,
    fixRound: row.fix_round as number,
    auditApprovedTreeOid: (row.audit_approved_tree_oid as string | null) ?? null,
    committedSha: (row.committed_sha as string | null) ?? null,
    landedSha: (row.landed_sha as string | null) ?? null,
    landedBaseSha: (row.landed_base_sha as string | null) ?? null,
    landingReasonCode: (row.landing_reason_code as string | null) ?? null,
    triageDecision: (row.triage_decision as TriageDecision | null) ?? null,
    triageRunStatus: (row.triage_run_status as TriageRunStatus | null) ?? null,
    triageBlockedReasonCode: (row.triage_blocked_reason_code as TriageReasonCode | null) ?? null,
    worktreeProvenance: (row.worktree_provenance as WorktreeProvenanceKind | null) ?? null,
    worktreeProvisionedAt: (row.worktree_provisioned_at_ms as number | null) ?? null,
    sourceRepoCommonDir: (row.source_repo_common_dir as string | null) ?? null,
    worktreeReasonCode: (row.worktree_reason_code as WorktreeReasonCode | null) ?? null,
    worktreeVerifiedAt: (row.worktree_verified_at_ms as number | null) ?? null,
    currentPlanArtifactId: (row.current_plan_artifact_id as string | null) ?? null,
    lastVerdict: (row.last_verdict as ReviewVerdict | null) ?? null,
    createdAt: row.created_at_ms as number,
    updatedAt: row.updated_at_ms as number
  }
}

export function sqliteRowToTransition(row: Record<string, unknown>): AuditedTaskTransitionRecord {
  return {
    seq: row.seq as number,
    fromState: (row.from_state as AuditedTaskState | null) ?? null,
    toState: row.to_state as AuditedTaskState,
    actor: row.actor as AuditedTaskActor,
    eventType: row.event_type as string,
    reasonCode: (row.reason_code as string | null) ?? null,
    at: row.at_ms as number
  }
}
