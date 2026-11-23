import { z } from 'zod'
import { parseOrcaSessionAddress } from '../../shared/agent-session/identity/orca-session-address'
import {
  sanitizeWorkTargetLabel,
  type ResolvedBotWorkTargetPlacement
} from '../../shared/agent-session/work-target/agent-session-work-target'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import {
  resolveWorkerLineage,
  type WorkerLineage
} from '../runtime/orchestration/db/dispatch-context/worker-follow-up-lineage'
import type { FederatedDispatchRow } from '../runtime/orchestration/db/orchestration-records'
import { OrchestrationError } from '../runtime/orchestration/orchestration-error'
import { readStructuredAgentSessionRecord } from '../runtime/orchestration/terminal-authority/structured-sessions/structured-worker-authority'
import {
  assertBotWorkTargetPairingRevision,
  describeExpectedPlacementFlags
} from './bot-turn-work-target'
import type { BotWorkTargetWorkspaceSummary } from './bot-work-target-refusals'
import {
  verifyLocalWorkspaceMatchesWorkTarget,
  WORK_TARGET_NO_EFFECTS,
  workTargetFollowUpRefusal
} from './bot-work-target-workspace-match'

export {
  isWorkTargetFollowUpMessageType,
  verifyLocalWorkspaceMatchesWorkTarget
} from './bot-work-target-workspace-match'

function parseIdentitySelectorInstanceId(selector: unknown): string | undefined {
  if (typeof selector !== 'string' || !selector.startsWith('identity:wt2:')) {
    return undefined
  }
  const rest = selector.slice('identity:wt2:'.length)
  const sep = rest.indexOf(':')
  if (sep <= 0 || sep >= rest.length - 1) {
    return undefined
  }
  try {
    const instanceId = decodeURIComponent(rest.slice(sep + 1))
    return instanceId.length > 0 ? instanceId : undefined
  } catch {
    return undefined
  }
}

const RecordedWorkerStartOptionsSchema = z.object({
  resolvedWorktreeInstanceId: z.string().min(1).nullable().optional(),
  worktree: z.string().nullable().optional()
})

/** Extract the checkout occupant instance ID recorded when a local worker started, if any. */
export function extractWorkerRecordedWorktreeInstanceId(
  db: OrchestrationDb,
  dispatchId: string,
  lineage: WorkerLineage | undefined
): string | undefined {
  const candidateIds = new Set<string>()
  if (lineage?.latest.id) {
    candidateIds.add(lineage.latest.id)
  }
  if (lineage?.resource?.origin_dispatch_id) {
    candidateIds.add(lineage.resource.origin_dispatch_id)
  }
  candidateIds.add(dispatchId)
  for (const id of candidateIds) {
    const worker = db.getWorkerDispatch(id)
    if (!worker?.start_options) {
      continue
    }
    try {
      const parsed = RecordedWorkerStartOptionsSchema.safeParse(JSON.parse(worker.start_options))
      if (!parsed.success) {
        continue
      }
      if (parsed.data.resolvedWorktreeInstanceId) {
        return parsed.data.resolvedWorktreeInstanceId
      }
      const fromSelector = parseIdentitySelectorInstanceId(parsed.data.worktree)
      if (fromSelector) {
        return fromSelector
      }
    } catch {
      continue
    }
  }
  return undefined
}

/** Verify a local/SSH worker Dispatch against `workTarget` before storing mail or starting a follow-up. */
export async function verifyLocalWorkerDispatchMatchesWorkTarget(
  runtime: Pick<
    OrcaRuntimeService,
    'showManagedTerminalWorkspace' | 'getBotWorkTargetCatalogStore' | 'showTerminal'
  >,
  db: OrchestrationDb,
  dispatchId: string,
  workTarget: ResolvedBotWorkTargetPlacement
): Promise<{ worktreeId: string; managed: BotWorkTargetWorkspaceSummary }> {
  const dispatch = db.getDispatchContextById(dispatchId)
  if (!dispatch) {
    throw workTargetFollowUpRefusal(
      workTarget,
      `Dispatch ${dispatchId} could not be resolved to verify its workspace.`
    )
  }
  const lineage = resolveWorkerLineage(db, dispatchId)
  const latest = lineage?.latest ?? dispatch
  const resource = lineage?.resource
  const worker =
    db.getWorkerDispatch(resource?.origin_dispatch_id ?? latest.id) ??
    db.getWorkerDispatch(dispatchId)
  let worktreeId = resource?.worktree_id ?? worker?.worktree_id ?? null
  if (!worktreeId && (latest.status === 'pending' || latest.status === 'dispatched')) {
    if (latest.assignee_orca_session_id) {
      worktreeId =
        readStructuredAgentSessionRecord(latest.assignee_orca_session_id)?.location.workspaceId ??
        null
    } else if (latest.assignee_handle) {
      worktreeId =
        (await runtime.showTerminal(latest.assignee_handle).catch(() => null))?.worktreeId ?? null
    }
  }
  if (!worktreeId) {
    throw workTargetFollowUpRefusal(
      workTarget,
      `Dispatch ${dispatchId} has no verifiable workspace identity.`
    )
  }
  const workerHostScope = resource?.host_scope ?? latest.host_scope ?? dispatch.host_scope
  const workerWorkspaceInstanceId = extractWorkerRecordedWorktreeInstanceId(db, dispatchId, lineage)
  return verifyLocalWorkspaceMatchesWorkTarget(runtime, {
    worktreeId,
    workTarget,
    recipientLabel: `dispatch:${dispatchId}`,
    workerHostScope,
    workerWorkspaceInstanceId,
    requireRecordedInstanceId: Boolean(workTarget.expectedWorkspaceInstanceId)
  })
}

/** Verify a local worker Dispatch satisfies every preserved/active work target simultaneously. */
export async function verifyLocalWorkerDispatchMatchesAllWorkTargets(
  runtime: Pick<
    OrcaRuntimeService,
    'showManagedTerminalWorkspace' | 'getBotWorkTargetCatalogStore' | 'showTerminal'
  >,
  db: OrchestrationDb,
  dispatchId: string,
  workTargets: readonly ResolvedBotWorkTargetPlacement[]
): Promise<{ worktreeId: string; managed: BotWorkTargetWorkspaceSummary } | undefined> {
  let verified: { worktreeId: string; managed: BotWorkTargetWorkspaceSummary } | undefined
  for (const target of workTargets) {
    verified = await verifyLocalWorkerDispatchMatchesWorkTarget(runtime, db, dispatchId, target)
  }
  return verified
}

/** Verify a bare local terminal or standalone session recipient against `workTarget`. */
export async function verifyBareRecipientMatchesWorkTarget(
  runtime: Pick<
    OrcaRuntimeService,
    | 'showManagedTerminalWorkspace'
    | 'getBotWorkTargetCatalogStore'
    | 'showTerminal'
    | 'getOrchestrationDispatchAuthority'
  >,
  recipient: string,
  workTarget: ResolvedBotWorkTargetPlacement
): Promise<{ worktreeId: string; managed: BotWorkTargetWorkspaceSummary }> {
  const sessionId = parseOrcaSessionAddress(recipient)
  let worktreeId: string | undefined
  let workerHostScope: string | null | undefined
  if (sessionId) {
    worktreeId = readStructuredAgentSessionRecord(sessionId)?.location.workspaceId
  } else {
    worktreeId = (await runtime.showTerminal(recipient).catch(() => null))?.worktreeId
    const authority = runtime.getOrchestrationDispatchAuthority?.(recipient)
    if (authority?.hostScope) {
      workerHostScope = JSON.stringify(authority.hostScope)
    }
  }
  if (!worktreeId) {
    throw workTargetFollowUpRefusal(
      workTarget,
      `${recipient} has no verifiable workspace identity.`
    )
  }
  return verifyLocalWorkspaceMatchesWorkTarget(runtime, {
    worktreeId,
    workTarget,
    recipientLabel: recipient,
    workerHostScope,
    requireRecordedInstanceId: Boolean(workTarget.expectedWorkspaceInstanceId)
  })
}

/** Enforce target host, pairing identity, and fail-closed refusal on legacy federated control mail. */
export async function verifyLegacyFederatedWorkTarget(
  runtime: Pick<OrcaRuntimeService, 'resolveOrchestrationWorkerServer'>,
  federatedTarget: FederatedDispatchRow,
  workTarget: ResolvedBotWorkTargetPlacement
): Promise<never> {
  if (!workTarget.onEnvironmentId) {
    throw workTargetFollowUpRefusal(
      workTarget,
      `dispatch:${federatedTarget.dispatch_id} runs on paired server ${federatedTarget.environment_name}, not the selected local/SSH target.`
    )
  }
  if (workTarget.onEnvironmentId !== federatedTarget.environment_id) {
    throw workTargetFollowUpRefusal(
      workTarget,
      `dispatch:${federatedTarget.dispatch_id} runs on paired server ${federatedTarget.environment_name}, which does not match the selected server.`
    )
  }
  let server: Awaited<ReturnType<OrcaRuntimeService['resolveOrchestrationWorkerServer']>>
  try {
    server = await runtime.resolveOrchestrationWorkerServer(federatedTarget.environment_id)
  } catch {
    throw new OrchestrationError(
      'server_pairing_changed',
      `Paired server ${federatedTarget.environment_name} is no longer available under the validated pairing. No effects were applied.`,
      WORK_TARGET_NO_EFFECTS
    )
  }
  assertBotWorkTargetPairingRevision(server, workTarget)
  if (server.peerFingerprint !== federatedTarget.peer_fingerprint) {
    throw new OrchestrationError(
      'server_pairing_changed',
      `The pairing with ${server.name} changed after dispatch:${federatedTarget.dispatch_id} was started. No effects were applied.`,
      { ...WORK_TARGET_NO_EFFECTS, server: server.name }
    )
  }
  const label = sanitizeWorkTargetLabel(workTarget.canonicalTarget.displayName)
  const expectedFlags = describeExpectedPlacementFlags(workTarget)
  throw new OrchestrationError(
    'capability_unsupported',
    `This turn targets "${label}". Legacy federated worker dispatch:${federatedTarget.dispatch_id} on ${server.name} cannot verify target registration and workspace incarnation for follow-up control mail; update ${server.name}'s Orca or start a new worker with \`orca orchestration worker-start ${expectedFlags}\`. No effects were applied.`,
    { ...WORK_TARGET_NO_EFFECTS, server: server.name }
  )
}
