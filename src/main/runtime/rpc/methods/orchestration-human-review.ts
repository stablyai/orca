import {
  MaestroHumanReviewCreateRequestSchema,
  MaestroHumanReviewListRequestSchema,
  MaestroHumanReviewTransitionRequestSchema,
  type MaestroHumanReviewCreateRequest
} from '../../../../shared/maestro-human-review'
import {
  createMaestroHumanReview,
  listMaestroHumanReviews,
  transitionMaestroHumanReview
} from '../../orchestration/db/maestro/maestro-human-review-store'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { defineMethod, type RpcContext, type RpcMethod } from '../core'
import { resolveMaestroPrincipal } from '../maestro-principal'

function requireCreateAuthority(
  context: RpcContext,
  request: MaestroHumanReviewCreateRequest,
  principal: Awaited<ReturnType<typeof resolveMaestroPrincipal>>
): void {
  const database = context.runtime.getOrchestrationDb()
  const run = database.getRun(request.workspace.run_id)
  if (!run || run.consumer_generation !== request.coordinator_generation) {
    throw new OrchestrationError(
      'unauthorized',
      'Human review creation requires the current Run generation.'
    )
  }
  if (principal.kind === 'user') {
    return
  }
  if (principal.kind === 'coordinator') {
    if (principal.generation === request.coordinator_generation) {
      return
    }
    throw new OrchestrationError('unauthorized', 'Human review coordinator authority is stale.')
  }
  const dispatch = database.getActiveDispatchForIdentity(principal.actor_id)
  if (
    !dispatch ||
    dispatch.id !== request.dispatch_id ||
    dispatch.task_id !== request.task_id ||
    dispatch.run_id !== request.workspace.run_id
  ) {
    throw new OrchestrationError(
      'unauthorized',
      'A worker may stage review only for its exact active Task and Dispatch.'
    )
  }
}

export const ORCHESTRATION_HUMAN_REVIEW_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'maestro.humanReview.create',
    params: MaestroHumanReviewCreateRequestSchema,
    handler: async (request, context) => {
      const principal = await resolveMaestroPrincipal(context, request.workspace)
      requireCreateAuthority(context, request, principal)
      return createMaestroHumanReview(context.runtime.getOrchestrationDb(), request, {
        actor_id: principal.actor_id,
        kind: principal.kind,
        authenticated: true,
        session_id: principal.session_id
      })
    }
  }),
  defineMethod({
    name: 'maestro.humanReview.list',
    params: MaestroHumanReviewListRequestSchema,
    handler: async ({ workspace }, context) => {
      await resolveMaestroPrincipal(context, workspace)
      return { reviews: listMaestroHumanReviews(context.runtime.getOrchestrationDb(), workspace) }
    }
  }),
  defineMethod({
    name: 'maestro.humanReview.transition',
    params: MaestroHumanReviewTransitionRequestSchema,
    handler: async (request, context) => {
      const principal = await resolveMaestroPrincipal(context, request.workspace)
      if (principal.kind !== 'user' || !principal.authenticated) {
        throw new OrchestrationError(
          'unauthorized',
          'Only an authenticated human may approve, submit, or reject a review.'
        )
      }
      return transitionMaestroHumanReview(context.runtime.getOrchestrationDb(), request, {
        actor_id: principal.actor_id,
        kind: 'user',
        authenticated: true,
        session_id: principal.session_id
      })
    }
  })
]
