import { z } from 'zod'
import {
  MaestroDelegationRequestSchema,
  parseMaestroDelegationRequest,
  resolveMaestroDelegationProfile
} from '../../../../shared/maestro-delegation'
import { MaestroWorkspaceAnchorSchema } from '../../../../shared/maestro-contract'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { defineMethod, type RpcMethod } from '../core'
import { resolveMaestroPrincipal } from '../maestro-principal'
import {
  requestMaestroDelegation,
  getMaestroDelegation,
  settleMaestroDelegation,
  takeMaestroDelegation
} from '../../orchestration/db/maestro/maestro-delegation-intent-store'
import {
  getMaestroDelegationCatalogSnapshot,
  resolveCatalogPlacement
} from './maestro-delegation-catalog'
import {
  requireCoordinatorPrincipal,
  requireRequestPrincipal,
  requireSourceBoundParents
} from './maestro-intent-authorization'

const catalogParams = z.object({ workspace: MaestroWorkspaceAnchorSchema }).strict()
const takeParams = z
  .object({ intent_id: z.string().min(1), workspace: MaestroWorkspaceAnchorSchema })
  .strict()
const getParams = z
  .object({ intent_id: z.string().min(1), workspace: MaestroWorkspaceAnchorSchema })
  .strict()
const settleParams = z
  .object({
    intent_id: z.string().min(1),
    workspace: MaestroWorkspaceAnchorSchema,
    receipt: z.unknown()
  })
  .strict()

export const MAESTRO_INTENT_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'maestro.delegation.catalog',
    params: catalogParams,
    handler: async ({ workspace }, context) => {
      await resolveMaestroPrincipal(context, workspace)
      return (await getMaestroDelegationCatalogSnapshot(context.runtime, workspace)).catalog
    }
  }),
  defineMethod({
    name: 'maestro.delegation.request',
    params: MaestroDelegationRequestSchema,
    handler: async (request, context) => {
      const parsed = parseMaestroDelegationRequest(request)
      const principal = await resolveMaestroPrincipal(context, parsed.workspace)
      requireRequestPrincipal(principal, parsed.workspace)
      const run = context.runtime.getOrchestrationDb().getRun(parsed.workspace.run_id)
      if (!run) {
        throw new OrchestrationError('run_not_found', 'Maestro requires an active Orca Run.')
      }
      const snapshot = await getMaestroDelegationCatalogSnapshot(context.runtime, parsed.workspace)
      const selectedAgent = parsed.requested.agent
        ? snapshot.catalog.agents.find((entry) => entry.id === parsed.requested.agent)
        : undefined
      if (parsed.requested.agent) {
        if (!isTuiAgent(parsed.requested.agent)) {
          throw new OrchestrationError(
            'agent_unconfigured',
            'The requested agent is not in Orca’s catalog.'
          )
        }
        if (!selectedAgent || !selectedAgent.enabled) {
          throw new OrchestrationError(
            'agent_disabled',
            selectedAgent?.disabled_reason ??
              'The requested agent is disabled in Orca agent settings.'
          )
        }
        context.runtime.validateOrchestrationAgentLauncher(parsed.requested.agent)
      }
      if (
        parsed.requested.model !== null &&
        (!selectedAgent ||
          !selectedAgent.models.some((model) => model.id === parsed.requested.model))
      ) {
        throw new OrchestrationError(
          'model_unconfigured',
          'The requested model is not available for this Orca agent.'
        )
      }
      if (
        parsed.requested.effort !== null &&
        (!parsed.requested.model ||
          !selectedAgent?.models
            .find((model) => model.id === parsed.requested.model)
            ?.efforts.includes(parsed.requested.effort))
      ) {
        throw new OrchestrationError(
          'effort_unconfigured',
          'The requested effort is not available for this Orca model.'
        )
      }
      const resolvedPlacement = resolveCatalogPlacement(snapshot.catalog, parsed.placement_request)
      if (
        !resolvedPlacement ||
        (parsed.placement_request.kind === 'current-workspace' && !snapshot.currentWorkspace)
      ) {
        throw new OrchestrationError(
          'unauthorized',
          'The requested Maestro placement is not available in this runtime.'
        )
      }
      requireSourceBoundParents(parsed, context.runtime.getOrchestrationDb())
      const resolved = resolveMaestroDelegationProfile({
        requested: parsed.requested,
        placement: resolvedPlacement,
        permissionMode: selectedAgent?.permission_mode ?? snapshot.catalog.permission_mode.value,
        currentWorkspace: snapshot.currentWorkspace ?? undefined
      })
      const generationPrincipal = { ...principal, generation: run.consumer_generation }
      return requestMaestroDelegation.call(
        context.runtime.getOrchestrationDb(),
        parsed,
        generationPrincipal,
        resolved
      )
    }
  }),
  defineMethod({
    name: 'maestro.delegation.get',
    params: getParams,
    handler: async ({ intent_id, workspace }, context) => {
      const principal = await resolveMaestroPrincipal(context, workspace)
      const intent = getMaestroDelegation.call(
        context.runtime.getOrchestrationDb(),
        intent_id,
        principal
      )
      if (!intent) {
        throw new OrchestrationError(
          'intent_unavailable',
          'Delegation intent is unavailable to this session.'
        )
      }
      return intent
    }
  }),
  defineMethod({
    name: 'maestro.delegation.take',
    params: takeParams,
    handler: async ({ intent_id, workspace }, context) => {
      const principal = await resolveMaestroPrincipal(context, workspace)
      const run = context.runtime.getOrchestrationDb().getRun(workspace.run_id)
      if (!run) {
        throw new OrchestrationError('run_not_found', 'Maestro requires an active Orca Run.')
      }
      requireCoordinatorPrincipal(
        principal,
        workspace,
        run.consumer_generation,
        'consume delegation intents'
      )
      const intent = takeMaestroDelegation.call(
        context.runtime.getOrchestrationDb(),
        intent_id,
        principal
      )
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
    name: 'maestro.delegation.settle',
    params: settleParams,
    handler: async ({ intent_id, workspace, receipt }, context) => {
      const principal = await resolveMaestroPrincipal(context, workspace)
      const run = context.runtime.getOrchestrationDb().getRun(workspace.run_id)
      if (!run) {
        throw new OrchestrationError('run_not_found', 'Maestro requires an active Orca Run.')
      }
      requireCoordinatorPrincipal(
        principal,
        workspace,
        run.consumer_generation,
        'settle delegation intents'
      )
      const intent = settleMaestroDelegation.call(
        context.runtime.getOrchestrationDb(),
        intent_id,
        principal,
        receipt
      )
      if (!intent) {
        throw new OrchestrationError(
          'intent_unavailable',
          'Delegation intent is unavailable to this coordinator.'
        )
      }
      return intent
    }
  })
]
