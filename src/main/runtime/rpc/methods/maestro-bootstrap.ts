import { createHash } from 'node:crypto'
import {
  MaestroBootstrapReceiptSchema,
  MaestroBootstrapRequestSchema,
  type MaestroBootstrapReceipt,
  type MaestroBootstrapRequest
} from '../../../../shared/maestro-bootstrap-contract'
import type { MaestroWorkspaceAnchor } from '../../../../shared/maestro-contract'
import {
  MAESTRO_COMPOSED_BOOTSTRAP_RUNTIME_CAPABILITY,
  WORKSPACE_BOOTSTRAP_RECEIPT_V2_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import { receiptToAgentGraphWorkspaceScope } from '../../../../shared/workspace-bootstrap-agent-graph-scope'
import { parseWorkspaceKey, worktreeWorkspaceKey } from '../../../../shared/workspace-scope'
import {
  applyMaestroBootstrapProjection,
  recordMaestroBootstrap,
  replayMaestroBootstrap
} from '../../orchestration/db/maestro/maestro-projection-store'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { defineMethod, type RpcContext, type RpcMethod } from '../core'
import { resolveMaestroDocumentReadScope } from '../maestro-principal'
import {
  issueWorkspaceBootstrapReceipt,
  requireCoordinatorWorkspace,
  requireWorkspaceBootstrapCoordinator,
  requireWorkspaceBootstrapHomeCapability
} from './workspace-bootstrap-receipt'
import { buildInitialMaestroProjection } from './maestro-projection'

function requireBootstrapCapabilities(context: RpcContext): void {
  if (context.clientCapabilities === undefined) {
    return
  }
  const required = [
    MAESTRO_COMPOSED_BOOTSTRAP_RUNTIME_CAPABILITY,
    WORKSPACE_BOOTSTRAP_RECEIPT_V2_RUNTIME_CAPABILITY
  ] as const
  const missing = required.filter((capability) => !context.clientCapabilities?.includes(capability))
  if (missing.length > 0) {
    throw new OrchestrationError(
      'update_required',
      `Maestro bootstrap requires runtime capabilities: ${missing.join(', ')}.`
    )
  }
}

function receiptDigest(receipt: unknown): string {
  const canonical = JSON.stringify(receipt, (_key, value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return value
    }
    return Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    )
  })
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`
}

export async function bootstrapMaestroProjection(
  context: RpcContext,
  request: MaestroBootstrapRequest
): Promise<MaestroBootstrapReceipt> {
  requireBootstrapCapabilities(context)
  const caller = requireWorkspaceBootstrapCoordinator(context, request.mutation.run_id)
  const database = context.runtime.getOrchestrationDb()
  const run = database.getRun(request.mutation.run_id)
  if (!run || run.consumer_generation !== request.coordinator_generation) {
    throw new OrchestrationError('consumer_fenced', 'Coordinator generation is stale.')
  }
  await resolveMaestroDocumentReadScope(context, {
    execution_host_id: request.mutation.execution_host_id,
    workspace_key: request.mutation.workspace_key
  })
  const terminal = context.runtime.getOrchestrationDispatchAuthority(caller.terminalHandle)
  if (!terminal || terminal.paneKey !== caller.paneKey) {
    throw new OrchestrationError('unauthorized', 'Coordinator workspace authority is unavailable.')
  }
  const orchestrationHomeKey = parseWorkspaceKey(terminal.worktreeId)
    ? terminal.worktreeId
    : worktreeWorkspaceKey(terminal.worktreeId)
  requireWorkspaceBootstrapHomeCapability(context, orchestrationHomeKey)
  const replay = replayMaestroBootstrap.call(database, request)
  if (replay) {
    requireCoordinatorWorkspace(
      context.runtime,
      caller,
      replay.workspace_scope.orchestration_home.workspace_key
    )
    return replay
  }

  const receipt = await issueWorkspaceBootstrapReceipt(context.runtime, {
    runId: request.mutation.run_id,
    orchestrationHomeSelector: orchestrationHomeKey,
    executionWorkspaceSelector: request.mutation.workspace_key,
    executionHostId: request.mutation.execution_host_id
  })
  requireCoordinatorWorkspace(context.runtime, caller, receipt.orchestration_home.workspace_key)
  if (receipt.execution_workspace.workspace_key !== request.mutation.workspace_key) {
    throw new OrchestrationError(
      'mutation_conflict',
      'Maestro bootstrap workspace does not match the host-issued receipt.'
    )
  }

  const workspaceScope = receiptToAgentGraphWorkspaceScope(receipt, {
    run_id: request.mutation.run_id,
    coordinator_generation: request.coordinator_generation,
    binding_receipt_ref: `artifact:workspace-bootstrap/${request.mutation.mutation_id}.json`,
    binding_receipt_hash: receiptDigest(receipt)
  })
  const view = buildInitialMaestroProjection(
    database,
    request,
    workspaceScope,
    caller.terminalHandle
  )
  const homeAnchor: MaestroWorkspaceAnchor = {
    repository_id: receipt.repository_id,
    execution_host_id: receipt.orchestration_home.execution_host_id,
    workspace_key: receipt.orchestration_home.workspace_key,
    run_id: request.mutation.run_id
  }
  let outcome: MaestroBootstrapReceipt['outcome']
  try {
    outcome = applyMaestroBootstrapProjection.call(database, homeAnchor, view)
  } catch (error) {
    throw new OrchestrationError(
      'maestro_bootstrap_conflict',
      error instanceof Error ? error.message : 'Maestro bootstrap was rejected.'
    )
  }
  const bootstrapReceipt = MaestroBootstrapReceiptSchema.parse({
    schema_version: 1,
    protocol: 'maestro-bootstrap-receipt/v1',
    mutation: request.mutation,
    coordinator_generation: request.coordinator_generation,
    workspace_scope: workspaceScope,
    projection_revision: 0,
    outcome
  })
  recordMaestroBootstrap.call(database, request, bootstrapReceipt)
  return bootstrapReceipt
}

export const MAESTRO_BOOTSTRAP_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'maestro.bootstrap',
    params: MaestroBootstrapRequestSchema,
    handler: async (request, context) => bootstrapMaestroProjection(context, request)
  })
]
