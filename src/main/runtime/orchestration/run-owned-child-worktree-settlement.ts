import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import type {
  RuntimeRunSettlementResult,
  RuntimeRunWorktreeCleanupResult,
  RuntimeWorktreePsSummary
} from '../../../shared/runtime-worktree-contracts'

export type RunOwnedChildWorktree = {
  worktreeId: string
  executionHostId?: ExecutionHostId
  worktreeInstanceId?: string
}

type HostQualifiedRunOwnedChildWorktree = RunOwnedChildWorktree & {
  executionHostId: ExecutionHostId
}
type QualifiedRunOwnedChildWorktree = Required<RunOwnedChildWorktree>

export type RunWorktreeProcessEvidence = {
  summaries: readonly RuntimeWorktreePsSummary[]
  queriedHostIds: ReadonlySet<ExecutionHostId>
}

export type RunWorktreeSettlementAuthority = {
  assertAbsent: (target: HostQualifiedRunOwnedChildWorktree) => Promise<void>
  retentionCause: (target: QualifiedRunOwnedChildWorktree) => string | undefined
  remove: (
    target: QualifiedRunOwnedChildWorktree
  ) => Promise<{ wasRegistered: boolean; reportedOk?: boolean }>
}

export async function settleRunOwnedChildWorktrees(params: {
  runId: string
  worktrees: readonly RunOwnedChildWorktree[]
  unreadableEffectRows: number
  processEvidence?: RunWorktreeProcessEvidence
  processEvidenceError?: string
  authority: RunWorktreeSettlementAuthority
}): Promise<RuntimeRunSettlementResult> {
  const warnings: string[] = []
  if (params.unreadableEffectRows > 0) {
    warnings.push(
      `Run ${params.runId} has unreadable worker effects; cleanup authority is unverifiable.`
    )
  }
  if (!params.processEvidence) {
    warnings.push(
      `Run ${params.runId} live-process evidence is unavailable: ${params.processEvidenceError ?? 'unknown failure'}.`
    )
  }

  const worktrees: RuntimeRunWorktreeCleanupResult[] = []
  for (const target of params.worktrees) {
    const base = {
      worktreeId: target.worktreeId,
      ...(target.executionHostId ? { executionHostId: target.executionHostId } : {})
    }
    if (!target.executionHostId) {
      const cause = 'The created-child effect has no execution host authority.'
      const action = 'Reconnect the owning host and verify the worktree manually.'
      warnings.push(`${target.worktreeId}: ${cause} ${action}`)
      worktrees.push({ ...base, disposition: 'unverifiable', cause, action })
      continue
    }
    const hostQualified = { ...target, executionHostId: target.executionHostId }
    if (!target.worktreeInstanceId) {
      await recordAbsenceOrUnverifiable({
        target: hostQualified,
        base,
        worktrees,
        warnings,
        authority: params.authority,
        cause: 'The created-child effect has no checkout instance identity.',
        action: 'Verify the current checkout occupant manually; do not remove it by path.'
      })
      continue
    }
    const qualified = {
      ...hostQualified,
      worktreeInstanceId: target.worktreeInstanceId
    }
    let retentionCause: string | undefined
    try {
      retentionCause = params.authority.retentionCause(qualified)
    } catch (error) {
      const cause = `Durable resource ownership is unverifiable: ${error instanceof Error ? error.message : String(error)}`
      const action = 'Repair or release the malformed resource record, then retry settlement.'
      warnings.push(`${target.worktreeId}: ${cause} ${action}`)
      worktrees.push({ ...base, disposition: 'unverifiable', cause, action })
      continue
    }
    if (retentionCause) {
      worktrees.push({
        ...base,
        disposition: 'retained',
        cause: retentionCause,
        action: 'Release or transfer the retained resource before retrying settlement.'
      })
      continue
    }
    if (!params.processEvidence?.queriedHostIds.has(qualified.executionHostId)) {
      await recordAbsenceOrUnverifiable({
        target: qualified,
        base,
        worktrees,
        warnings,
        authority: params.authority,
        cause: `Live process inventory did not cover execution host ${qualified.executionHostId}.`,
        action: 'Reconnect the execution host and retry settlement.'
      })
      continue
    }
    const summary = params.processEvidence.summaries.find(
      (candidate) =>
        candidate.worktreeId === qualified.worktreeId &&
        (candidate.hostId ?? LOCAL_EXECUTION_HOST_ID) === qualified.executionHostId &&
        candidate.worktreeInstanceId === qualified.worktreeInstanceId
    )
    if (!summary) {
      await recordAbsenceOrUnverifiable({
        target: qualified,
        base,
        worktrees,
        warnings,
        authority: params.authority,
        cause: 'Live process evidence does not include this exact owned checkout.',
        action: 'Refresh or reconnect the execution host and retry settlement.'
      })
      continue
    }
    const liveAgent = summary.agents.some((agent) => agent.state !== 'done')
    if (liveAgent || summary.status === 'working' || summary.status === 'permission') {
      worktrees.push({
        ...base,
        disposition: 'retained',
        cause: 'Live agent or foreground execution remains in the worktree.',
        action: 'Settle or stop the live execution before retrying settlement.'
      })
      continue
    }
    try {
      const removal = await params.authority.remove(qualified)
      await params.authority.assertAbsent(qualified)
      worktrees.push({
        ...base,
        disposition: removal.wasRegistered ? 'removed' : 'already_absent'
      })
    } catch (error) {
      try {
        await params.authority.assertAbsent(qualified)
        worktrees.push({ ...base, disposition: 'already_absent' })
      } catch {
        const cause = error instanceof Error ? error.message : String(error)
        const unverifiable = /unverifiable|disconnect|connection|timed? out|unavailable/i.test(
          cause
        )
        const action = unverifiable
          ? 'Reconnect the execution host and retry settlement.'
          : 'Commit or preserve changes, settle live resources, then retry settlement.'
        warnings.push(`${target.worktreeId}: ${cause} ${action}`)
        worktrees.push({
          ...base,
          disposition: unverifiable ? 'unverifiable' : 'pending',
          cause,
          action
        })
      }
    }
  }

  const state = worktrees.some((worktree) => worktree.disposition === 'unverifiable')
    ? 'unverifiable'
    : worktrees.some((worktree) => ['retained', 'pending'].includes(worktree.disposition))
      ? 'pending'
      : warnings.length > 0
        ? 'unverifiable'
        : 'settled'
  return { runId: params.runId, state, worktrees, warnings }
}

async function recordAbsenceOrUnverifiable(params: {
  target: HostQualifiedRunOwnedChildWorktree
  base: { worktreeId: string; executionHostId?: ExecutionHostId }
  worktrees: RuntimeRunWorktreeCleanupResult[]
  warnings: string[]
  authority: RunWorktreeSettlementAuthority
  cause: string
  action: string
}): Promise<void> {
  try {
    await params.authority.assertAbsent(params.target)
    params.worktrees.push({ ...params.base, disposition: 'already_absent' })
  } catch {
    params.warnings.push(`${params.target.worktreeId}: ${params.cause} ${params.action}`)
    params.worktrees.push({
      ...params.base,
      disposition: 'unverifiable',
      cause: params.cause,
      action: params.action
    })
  }
}
