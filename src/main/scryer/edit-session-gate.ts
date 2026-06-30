import type { PendingChange } from './engine/diff'
import type {
  ModelEditLease,
  PendingSummary,
  ScryerModelValidateResult,
  ScryerPlanFoldInput,
  ScryerPlanPendingResult,
  ScryerValidationFinding
} from './engine'

export type CompletionGateNextAction =
  | 'nothing_to_fold'
  | 'fold_allowed'
  | 'fix_validation'
  | 'manual_review'
  | 'blocked_by_lease'

export type CompletionGateBlocker = {
  code: 'validation_error' | 'unknown_pending_kind' | 'unknown_pending_change' | 'lease_conflict'
  message: string
  path?: string
  details?: Record<string, unknown>
}

export type CompletionGateRisk = {
  code: 'destructive_change' | 'structural_change'
  message: string
  changeId: string
  changeKind: string
}

export type CompletionGateResult = {
  ok: boolean
  foldAllowed: boolean
  nextAction: CompletionGateNextAction
  pending: {
    total: number
    foldable: boolean
    byKind: PendingSummary['byKind']
    byChange: PendingSummary['byChange']
    changes: PendingChange[]
    blockers: CompletionGateBlocker[]
    risks: CompletionGateRisk[]
  }
  validation: {
    blockingCount: number
    warningCount: number
    findings: ScryerValidationFinding[]
  }
  lease: {
    active: boolean
    blocked: boolean
    owner?: ModelEditLease['owner']
    agentRunId?: string
  }
}

export type EvaluateCompletionGateInput = {
  pending: ScryerPlanPendingResult
  validation: ScryerModelValidateResult
  activeLease?: ModelEditLease | null
  agentRunId?: string
}

const KNOWN_PENDING_KINDS = new Set(['node', 'link', 'responsibility', 'property', 'group'])
const KNOWN_PENDING_CHANGE_TYPES = new Set([
  'added',
  'deleted',
  'moved',
  'repointed',
  'reworded',
  'membersChanged'
])

function pendingBlockers(changes: PendingChange[]): CompletionGateBlocker[] {
  const blockers: CompletionGateBlocker[] = []
  for (const change of changes) {
    if (!KNOWN_PENDING_KINDS.has(change.kind)) {
      blockers.push({
        code: 'unknown_pending_kind',
        message: `Pending change kind '${change.kind}' requires manual review`,
        details: { kind: change.kind, id: change.id }
      })
    }
    for (const item of change.changes) {
      if (!KNOWN_PENDING_CHANGE_TYPES.has(item.type)) {
        blockers.push({
          code: 'unknown_pending_change',
          message: `Pending change type '${item.type}' requires manual review`,
          details: { type: item.type, kind: change.kind, id: change.id }
        })
      }
    }
  }
  return blockers
}

function pendingRisks(changes: PendingChange[]): CompletionGateRisk[] {
  const risks: CompletionGateRisk[] = []
  for (const change of changes) {
    for (const item of change.changes) {
      if (item.type === 'deleted') {
        risks.push({
          code: 'destructive_change',
          message: `${change.kind} '${change.id}' will be deleted`,
          changeId: change.id,
          changeKind: change.kind
        })
      } else if (
        item.type === 'moved' ||
        item.type === 'repointed' ||
        item.type === 'membersChanged'
      ) {
        risks.push({
          code: 'structural_change',
          message: `${change.kind} '${change.id}' has a structural change`,
          changeId: change.id,
          changeKind: change.kind
        })
      }
    }
  }
  return risks
}

function leaseBlocker(input: EvaluateCompletionGateInput): CompletionGateBlocker | null {
  const lease = input.activeLease
  if (!lease) {
    return null
  }
  if (lease.owner && lease.owner !== 'agent') {
    return {
      code: 'lease_conflict',
      message: `Active Scryer edit lease is owned by ${lease.owner}`,
      details: { owner: lease.owner, agentRunId: input.agentRunId }
    }
  }
  if (lease.agentRunId && lease.agentRunId !== input.agentRunId) {
    return {
      code: 'lease_conflict',
      message: `Active Scryer edit lease is bound to agent run '${lease.agentRunId}'`,
      details: { agentRunId: input.agentRunId, leaseAgentRunId: lease.agentRunId }
    }
  }
  return null
}

function compactFoldInput(input: ScryerPlanFoldInput): ScryerPlanFoldInput | null {
  const compacted: ScryerPlanFoldInput = { mode: 'agent_completion' }
  if (input.node_id) {
    compacted.node_id = input.node_id
  }
  if (input.responsibility_ids && input.responsibility_ids.length > 0) {
    compacted.responsibility_ids = input.responsibility_ids
  }
  if (input.properties && input.properties.length > 0) {
    compacted.properties = input.properties
  }
  if (input.link_ids && input.link_ids.length > 0) {
    compacted.link_ids = input.link_ids
  }
  if (input.group_ids && input.group_ids.length > 0) {
    compacted.group_ids = input.group_ids
  }
  return Object.keys(compacted).length > 1 ? compacted : null
}

export function foldInputsFor(changes: PendingChange[]): ScryerPlanFoldInput[] {
  const inputs: ScryerPlanFoldInput[] = []
  const shared: ScryerPlanFoldInput = {
    mode: 'agent_completion',
    responsibility_ids: [],
    properties: [],
    link_ids: [],
    group_ids: []
  }
  for (const change of changes) {
    switch (change.kind) {
      case 'node':
        inputs.push({ mode: 'agent_completion', node_id: change.id })
        break
      case 'responsibility':
        shared.responsibility_ids?.push(change.id)
        break
      case 'property':
        if (change.ownerId) {
          shared.properties?.push({ node_id: change.ownerId, label: change.id })
        }
        break
      case 'link':
        shared.link_ids?.push(change.id)
        break
      case 'group':
        shared.group_ids?.push(change.id)
        break
    }
  }
  const sharedInput = compactFoldInput(shared)
  return sharedInput ? [...inputs, sharedInput] : inputs
}

export function evaluateCompletionGate(input: EvaluateCompletionGateInput): CompletionGateResult {
  const validationBlockers = input.validation.findings.filter(
    (finding) => finding.severity === 'error'
  )
  const validationGateBlockers: CompletionGateBlocker[] = validationBlockers.map((finding) => ({
    code: 'validation_error',
    message: finding.message,
    path: finding.path,
    details: finding.details
  }))
  const pendingGateBlockers = pendingBlockers(input.pending.changes)
  const leaseGateBlocker = leaseBlocker(input)
  const risks = pendingRisks(input.pending.changes)
  const blockers: CompletionGateBlocker[] = [
    ...(leaseGateBlocker ? [leaseGateBlocker] : []),
    ...validationGateBlockers,
    ...pendingGateBlockers
  ]
  const foldable = blockers.length === 0
  const hasChanges = input.pending.summary.total > 0
  const nextAction: CompletionGateNextAction = leaseGateBlocker
    ? 'blocked_by_lease'
    : validationGateBlockers.length > 0
      ? 'fix_validation'
      : pendingGateBlockers.length > 0
        ? 'manual_review'
        : hasChanges
          ? 'fold_allowed'
          : 'nothing_to_fold'
  return {
    ok: blockers.length === 0,
    foldAllowed: foldable && hasChanges,
    nextAction,
    pending: {
      total: input.pending.summary.total,
      foldable,
      byKind: input.pending.summary.byKind,
      byChange: input.pending.summary.byChange,
      changes: input.pending.changes,
      blockers,
      risks
    },
    validation: {
      blockingCount: validationBlockers.length,
      warningCount: input.validation.findings.filter((finding) => finding.severity === 'warning')
        .length,
      findings: input.validation.findings
    },
    lease: {
      active: Boolean(input.activeLease),
      blocked: Boolean(leaseGateBlocker),
      owner: input.activeLease?.owner,
      agentRunId: input.activeLease?.agentRunId
    }
  }
}
