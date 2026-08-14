import {
  getAgentResumeArgv,
  isResumableTuiAgent,
  normalizeAgentProviderSession,
  type AgentProviderSessionMetadata,
  type ResumableTuiAgent
} from '../../../shared/agent-session-resume'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { OrchestrationDb } from './db'
import { OrchestrationError } from './orchestration-error'

export type WorkerResumeCheckpoint = {
  sourceDispatchId: string
  worktreeId: string
  hostScope: string
  processIncarnation: string
  agent: ResumableTuiAgent
  providerSession: AgentProviderSessionMetadata
}

export function captureWorkerResumeCheckpoint(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  dispatchId: string
  terminalHandle: string
  worktreeId: string
  observedAfterMs: number
}): 'captured' | 'unavailable' {
  const worker = args.db.getWorkerDispatch(args.dispatchId)
  const resource = args.db.getWorkerTerminalResourceByOwner(args.dispatchId)
  const session = args.runtime.getExactWorkerProviderSession(
    args.terminalHandle,
    args.observedAfterMs
  )
  const authority = args.runtime.getOrchestrationDispatchAuthority(args.terminalHandle)
  const expectedAgent = readStartAgent(worker?.start_options)
  if (
    !worker ||
    !resource ||
    resource.ownership_state !== 'owned' ||
    !session ||
    !authority?.processIncarnation ||
    !authority.hostScope ||
    authority.worktreeId !== args.worktreeId ||
    session.processIncarnation !== authority.processIncarnation ||
    resource.process_incarnation !== authority.processIncarnation ||
    resource.host_scope !== JSON.stringify(authority.hostScope) ||
    (expectedAgent !== null && expectedAgent !== session.agent)
  ) {
    return 'unavailable'
  }
  args.db.storeWorkerResumeCheckpoint({
    sourceDispatchId: args.dispatchId,
    worktreeId: args.worktreeId,
    hostScope: JSON.stringify(authority.hostScope),
    processIncarnation: session.processIncarnation,
    agent: session.agent,
    providerSession: session.providerSession
  })
  return 'captured'
}

export function resolveWorkerResumeCheckpoint(args: {
  db: OrchestrationDb
  sourceDispatchId: string
}): WorkerResumeCheckpoint {
  const worker = args.db.getWorkerDispatch(args.sourceDispatchId)
  if (!worker) {
    throw new OrchestrationError(
      'resume_dispatch_not_found',
      `Worker Dispatch ${args.sourceDispatchId} was not found on this Orca server.`
    )
  }
  if (!['succeeded', 'failed'].includes(worker.state)) {
    throw new OrchestrationError(
      'resume_source_active',
      `Worker Dispatch ${args.sourceDispatchId} is ${worker.state}; only a settled, released worker can resume.`
    )
  }
  const resource = args.db.getWorkerTerminalResourceByOwner(args.sourceDispatchId)
  if (
    !resource ||
    resource.ownership_state !== 'released' ||
    resource.release_state !== 'released'
  ) {
    throw new OrchestrationError(
      'resume_source_not_closed',
      `Worker Dispatch ${args.sourceDispatchId} does not own a safely released terminal.`
    )
  }
  const row = args.db.getWorkerResumeCheckpoint(args.sourceDispatchId)
  if (!row) {
    throw new OrchestrationError(
      'resume_checkpoint_missing',
      `Worker Dispatch ${args.sourceDispatchId} has no durable provider-session resume checkpoint.`
    )
  }
  if (
    row.worktree_id !== worker.worktree_id ||
    row.worktree_id !== resource.worktree_id ||
    row.process_incarnation !== resource.process_incarnation ||
    row.host_scope !== resource.host_scope
  ) {
    throw new OrchestrationError(
      'resume_checkpoint_mismatch',
      `Worker Dispatch ${args.sourceDispatchId} resume ownership no longer matches its worktree or execution host.`
    )
  }
  if (row.resumed_by_dispatch_id) {
    throw new OrchestrationError(
      'resume_checkpoint_claimed',
      `Worker Dispatch ${args.sourceDispatchId} has already been resumed by another worker Dispatch.`
    )
  }
  if (!isResumableTuiAgent(row.agent)) {
    throw new OrchestrationError(
      'resume_agent_unsupported',
      `Worker Dispatch ${args.sourceDispatchId} used an agent that does not support native resume.`
    )
  }
  const expectedAgent = readStartAgent(worker.start_options)
  if (expectedAgent !== null && expectedAgent !== row.agent) {
    throw new OrchestrationError(
      'resume_provider_mismatch',
      `Worker Dispatch ${args.sourceDispatchId} no longer matches its recorded provider family.`
    )
  }
  const providerSession = parseProviderSession(row.provider_session)
  if (!providerSession || !getAgentResumeArgv(row.agent, providerSession)) {
    throw new OrchestrationError(
      'resume_provider_mismatch',
      `Worker Dispatch ${args.sourceDispatchId} has incompatible provider-session metadata.`
    )
  }
  return {
    sourceDispatchId: row.source_dispatch_id,
    worktreeId: row.worktree_id,
    hostScope: row.host_scope,
    processIncarnation: row.process_incarnation,
    agent: row.agent,
    providerSession
  }
}

export function captureRemoteWorkerResumeCheckpoint(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  dispatchId: string
}): 'captured' | 'unavailable' {
  const attachment = args.db.getRemoteDispatchAttachment(args.dispatchId)
  if (!attachment?.terminal_handle || !attachment.worktree_id) {
    return 'unavailable'
  }
  const session = args.runtime.getExactWorkerProviderSession(
    attachment.terminal_handle,
    Date.parse(attachment.created_at)
  )
  const authority = args.runtime.getOrchestrationDispatchAuthority(attachment.terminal_handle)
  if (
    !session ||
    !authority?.processIncarnation ||
    !authority.hostScope ||
    authority.worktreeId !== attachment.worktree_id ||
    session.processIncarnation !== authority.processIncarnation ||
    attachment.process_incarnation !== authority.processIncarnation
  ) {
    return 'unavailable'
  }
  args.db.storeWorkerResumeCheckpoint({
    sourceDispatchId: args.dispatchId,
    worktreeId: attachment.worktree_id,
    hostScope: JSON.stringify(authority.hostScope),
    processIncarnation: session.processIncarnation,
    agent: session.agent,
    providerSession: session.providerSession
  })
  return 'captured'
}

export function resolveRemoteWorkerResumeCheckpoint(args: {
  db: OrchestrationDb
  sourceDispatchId: string
}): WorkerResumeCheckpoint {
  const attachment = args.db.getRemoteDispatchAttachment(args.sourceDispatchId)
  if (!attachment) {
    throw new OrchestrationError(
      'resume_dispatch_not_found',
      `Remote worker Dispatch ${args.sourceDispatchId} was not found on this Orca server.`
    )
  }
  if (!['succeeded', 'failed'].includes(attachment.state)) {
    throw new OrchestrationError(
      'resume_source_active',
      `Remote worker Dispatch ${args.sourceDispatchId} is ${attachment.state}; only a settled worker can resume.`
    )
  }
  const row = args.db.getWorkerResumeCheckpoint(args.sourceDispatchId)
  if (!row) {
    throw new OrchestrationError(
      'resume_checkpoint_missing',
      `Remote worker Dispatch ${args.sourceDispatchId} has no durable provider-session resume checkpoint.`
    )
  }
  if (
    !attachment.worktree_id ||
    row.worktree_id !== attachment.worktree_id ||
    row.process_incarnation !== attachment.process_incarnation
  ) {
    throw new OrchestrationError(
      'resume_checkpoint_mismatch',
      `Remote worker Dispatch ${args.sourceDispatchId} resume ownership no longer matches its worktree or process.`
    )
  }
  return resolveCheckpointRow(args.sourceDispatchId, row)
}

function readStartAgent(startOptions: string | undefined): string | null {
  try {
    const parsed: unknown = JSON.parse(startOptions ?? '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }
    const agent = (parsed as { agent?: unknown }).agent
    return typeof agent === 'string' ? agent : null
  } catch {
    return null
  }
}

function parseProviderSession(value: string): AgentProviderSessionMetadata | null {
  try {
    return normalizeAgentProviderSession(JSON.parse(value))
  } catch {
    return null
  }
}

function resolveCheckpointRow(
  sourceDispatchId: string,
  row: ReturnType<OrchestrationDb['getWorkerResumeCheckpoint']>
): WorkerResumeCheckpoint {
  if (!row) {
    throw new OrchestrationError('resume_checkpoint_missing', 'Resume checkpoint is missing.')
  }
  if (row.resumed_by_dispatch_id) {
    throw new OrchestrationError(
      'resume_checkpoint_claimed',
      `Worker Dispatch ${sourceDispatchId} has already been resumed by another worker Dispatch.`
    )
  }
  if (!isResumableTuiAgent(row.agent)) {
    throw new OrchestrationError(
      'resume_agent_unsupported',
      `Worker Dispatch ${sourceDispatchId} used an agent that does not support native resume.`
    )
  }
  const providerSession = parseProviderSession(row.provider_session)
  if (!providerSession || !getAgentResumeArgv(row.agent, providerSession)) {
    throw new OrchestrationError(
      'resume_provider_mismatch',
      `Worker Dispatch ${sourceDispatchId} has incompatible provider-session metadata.`
    )
  }
  return {
    sourceDispatchId: row.source_dispatch_id,
    worktreeId: row.worktree_id,
    hostScope: row.host_scope,
    processIncarnation: row.process_incarnation,
    agent: row.agent,
    providerSession
  }
}
