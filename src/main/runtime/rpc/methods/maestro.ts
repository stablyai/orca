import { z } from 'zod'
import {
  DelegationIntentSchema,
  MaestroDocumentAuthoringMutationSchema,
  MaestroDocumentLayoutMutationSchema,
  MaestroDocumentReadScopeSchema,
  MaestroMutationSchema,
  MaestroWorkspaceAnchorSchema
} from '../../../../shared/maestro-contract'
import { canConsumeMaestroIntent, canRequestMaestroIntent } from '../../../../shared/maestro-actor'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { getMaestroProjection } from '../../orchestration/db/maestro/maestro-projection-store'
import { defineMethod, type RpcMethod } from '../core'
import {
  resolveMaestroDocumentReadScope,
  resolveMaestroLayoutPrincipal,
  resolveMaestroPrincipal
} from '../maestro-principal'
import { MAESTRO_BOOTSTRAP_METHODS } from './maestro-bootstrap'

const documentParams = z.object({ scope: MaestroDocumentReadScopeSchema }).strict()
const deltaParams = z
  .object({ workspace: MaestroWorkspaceAnchorSchema, sinceRevision: z.number().int().min(0) })
  .strict()
const takeParams = z
  .object({ intentId: z.string().min(1), workspace: MaestroWorkspaceAnchorSchema })
  .strict()
const settleParams = z
  .object({
    intentId: z.string().min(1),
    workspace: MaestroWorkspaceAnchorSchema,
    receipt: z.unknown()
  })
  .strict()
const snapshotParams = z
  .object({ snapshotId: z.string().min(1), workspace: MaestroWorkspaceAnchorSchema })
  .strict()
const canvasOpenParams = z
  .object({ execution_host_id: z.string().min(1), workspace_key: z.string().min(1) })
  .strict()

function requireRequestAuthority(
  principal: Awaited<ReturnType<typeof resolveMaestroPrincipal>>,
  workspace: z.infer<typeof MaestroWorkspaceAnchorSchema>,
  message: string
): void {
  if (!canRequestMaestroIntent(principal, workspace)) {
    throw new OrchestrationError('unauthorized', message)
  }
}

export const MAESTRO_METHODS: RpcMethod[] = [
  ...MAESTRO_BOOTSTRAP_METHODS,
  defineMethod({
    name: 'maestro.document.get',
    params: documentParams,
    handler: async ({ scope }, context) => {
      const resolvedScope = await resolveMaestroDocumentReadScope(context, scope)
      const database = context.runtime.getOrchestrationDb()
      const document = database.getMaestroDocument(resolvedScope)
      const projection = getMaestroProjection.call(database, resolvedScope)
      if (!projection && document.state === 'empty') {
        return document
      }
      return {
        ...document,
        documentState: document.state,
        documentRevision: document.revision,
        projectionState: projection ? 'ready' : 'empty',
        projectionRevision: projection?.revision ?? null,
        recoveryHint:
          document.state === 'empty' && projection
            ? 'A projected Run exists without an authorable document. Use maestro projection show to inspect it.'
            : null
      }
    }
  }),
  defineMethod({
    name: 'maestro.document.deltas',
    params: deltaParams,
    handler: async ({ workspace, sinceRevision }, context) => {
      const principal = await resolveMaestroPrincipal(context, workspace)
      requireRequestAuthority(
        principal,
        workspace,
        'The authenticated session cannot read this Maestro workspace.'
      )
      return context.runtime.getOrchestrationDb().getMaestroDeltas(workspace, sinceRevision)
    }
  }),
  defineMethod({
    name: 'maestro.canvas.open',
    params: canvasOpenParams,
    handler: async (scope, context) => {
      const resolvedScope = await resolveMaestroDocumentReadScope(context, scope)
      const opened = await context.runtime.openMaestroCanvas({
        executionHostId: resolvedScope.execution_host_id,
        workspaceKey: resolvedScope.workspace_key
      })
      if (!opened) {
        throw new OrchestrationError(
          'canvas_open_unavailable',
          'The exact Maestro workspace is unavailable in the native Canvas.'
        )
      }
      return { opened: true, ...resolvedScope }
    }
  }),
  defineMethod({
    name: 'maestro.mutation.apply',
    params: MaestroMutationSchema,
    handler: async (mutation, context) => {
      const principal = await resolveMaestroPrincipal(context, mutation.workspace)
      requireRequestAuthority(
        principal,
        mutation.workspace,
        'The authenticated session cannot mutate this Maestro workspace.'
      )
      const run = context.runtime.getOrchestrationDb().getRun(mutation.workspace.run_id)
      if (!run) {
        throw new OrchestrationError('run_not_found', 'Maestro requires an active Orca Run.')
      }
      return context.runtime.getOrchestrationDb().applyMaestroMutation(
        {
          ...mutation,
          actor: {
            actor_id: principal.actor_id,
            kind: principal.kind,
            authenticated: true,
            session_id: principal.session_id
          },
          coordinator_generation: principal.generation ?? run.consumer_generation
        },
        principal
      )
    }
  }),
  defineMethod({
    name: 'maestro.document.layout.apply',
    params: MaestroDocumentLayoutMutationSchema,
    handler: async (mutation, context) => {
      const principal = await resolveMaestroLayoutPrincipal(context, mutation.scope)
      return context.runtime
        .getOrchestrationDb()
        .applyMaestroDocumentLayoutMutation({ ...mutation, scope: principal.workspace }, principal)
    }
  }),
  defineMethod({
    name: 'maestro.document.authoring.apply',
    params: MaestroDocumentAuthoringMutationSchema,
    handler: async (mutation, context) => {
      const principal = await resolveMaestroPrincipal(context, mutation.scope)
      const db = context.runtime.getOrchestrationDb()
      const projection = getMaestroProjection.call(db, {
        execution_host_id: principal.workspace.execution_host_id,
        workspace_key: principal.workspace.workspace_key
      })
      if (
        !projection ||
        projection.repositoryId !== mutation.scope.repository_id ||
        projection.runId !== mutation.scope.run_id ||
        projection.coordinator.generation !== db.getRun(mutation.scope.run_id)?.consumer_generation
      ) {
        throw new OrchestrationError(
          'unauthorized',
          'Authoring mutations require the current Maestro projection anchor.'
        )
      }
      return context.runtime
        .getOrchestrationDb()
        .applyMaestroDocumentAuthoringMutation(mutation, principal)
    }
  }),
  defineMethod({
    name: 'maestro.intent.request',
    params: DelegationIntentSchema,
    handler: async (intent, context) => {
      const principal = await resolveMaestroPrincipal(context, intent.workspace)
      requireRequestAuthority(
        principal,
        intent.workspace,
        'The authenticated session cannot request this delegation.'
      )
      const run = context.runtime.getOrchestrationDb().getRun(intent.workspace.run_id)
      if (!run) {
        throw new OrchestrationError('run_not_found', 'Maestro requires an active Orca Run.')
      }
      return context.runtime.getOrchestrationDb().requestMaestroDelegationIntent(
        {
          ...intent,
          actor: {
            actor_id: principal.actor_id,
            kind: principal.kind,
            authenticated: true,
            session_id: principal.session_id
          },
          coordinator_generation: run.consumer_generation
        },
        principal
      )
    }
  }),
  defineMethod({
    name: 'maestro.intent.take',
    params: takeParams,
    handler: async ({ intentId, workspace }, context) => {
      const principal = await resolveMaestroPrincipal(context, workspace)
      if (!canConsumeMaestroIntent(principal, workspace, principal.generation ?? 0)) {
        throw new OrchestrationError(
          'unauthorized',
          'Only the authenticated current coordinator can consume delegation intents.'
        )
      }
      const intent = context.runtime
        .getOrchestrationDb()
        .takeMaestroDelegationIntent(intentId, principal)
      if (!intent) {
        throw new OrchestrationError(
          'intent_unavailable',
          'Delegation intent is unavailable to this coordinator.'
        )
      }
      return intent
    }
  }),
  defineMethod({
    name: 'maestro.intent.settle',
    params: settleParams,
    handler: async ({ intentId, workspace, receipt }, context) => {
      const principal = await resolveMaestroPrincipal(context, workspace)
      if (!canConsumeMaestroIntent(principal, workspace, principal.generation ?? 0)) {
        throw new OrchestrationError(
          'unauthorized',
          'Only the authenticated current coordinator can settle delegation intents.'
        )
      }
      if (
        !context.runtime
          .getOrchestrationDb()
          .settleMaestroDelegationIntent(intentId, principal, receipt)
      ) {
        throw new OrchestrationError(
          'intent_unavailable',
          'Delegation intent is unavailable to this coordinator.'
        )
      }
      return { intentId, state: 'settled' as const }
    }
  }),
  defineMethod({
    name: 'maestro.snapshot.get',
    params: snapshotParams,
    handler: async ({ snapshotId, workspace }, context) => {
      const principal = await resolveMaestroPrincipal(context, workspace)
      if (!canConsumeMaestroIntent(principal, workspace, principal.generation ?? 0)) {
        throw new OrchestrationError(
          'unauthorized',
          'Only the authenticated current coordinator can fetch Maestro context.'
        )
      }
      const snapshot = context.runtime
        .getOrchestrationDb()
        .getMaestroContextSnapshot(snapshotId, principal)
      if (!snapshot) {
        throw new OrchestrationError(
          'snapshot_unavailable',
          'Maestro context snapshot is unavailable to this coordinator.'
        )
      }
      return snapshot
    }
  }),
  defineMethod({
    name: 'maestro.snapshot.release',
    params: snapshotParams,
    handler: async ({ snapshotId, workspace }, context) => {
      const principal = await resolveMaestroPrincipal(context, workspace)
      if (!canConsumeMaestroIntent(principal, workspace, principal.generation ?? 0)) {
        throw new OrchestrationError(
          'unauthorized',
          'Only the authenticated current coordinator can release Maestro context.'
        )
      }
      if (
        !context.runtime.getOrchestrationDb().releaseMaestroContextSnapshot(snapshotId, principal)
      ) {
        throw new OrchestrationError(
          'snapshot_unavailable',
          'Maestro context snapshot is unavailable to this coordinator.'
        )
      }
      return { snapshotId, state: 'released' as const }
    }
  })
]
