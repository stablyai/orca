import { randomUUID } from 'node:crypto'
import { defineMethod, defineStreamingMethod, type RpcContext } from '../core'
import { WORKTREE_REVIEW_STATUS_RUNTIME_CAPABILITY } from '../../../../shared/worktree-runtime-capabilities'
import type { OrcaRuntimeService } from '../../orca-runtime'
import {
  WorktreeReviewSubscribe,
  WorktreeReviewSubscription
} from '../../../../shared/rpc-contract/worktree-review-params'
import { WorkspaceReviewSubscription } from '../../workspace-review-subscription'

const subscriptions = new WeakMap<OrcaRuntimeService, Map<string, WorkspaceReviewSubscription>>()

function requireReviewStatusCapability(context: RpcContext): void {
  if (
    context.clientKind !== undefined &&
    !context.clientCapabilities?.includes(WORKTREE_REVIEW_STATUS_RUNTIME_CAPABILITY)
  ) {
    throw new Error('worktree_review_status_capability_required')
  }
}

export const WORKTREE_REVIEW_METHODS = [
  defineStreamingMethod({
    name: 'worktree.review.subscribe',
    permission: 'workspace',
    params: WorktreeReviewSubscribe,
    handler: async (params, context, emit) => {
      requireReviewStatusCapability(context)
      const { runtime, connectionId, requestId, signal } = context
      let registry = subscriptions.get(runtime)
      if (!registry) {
        registry = new Map()
        subscriptions.set(runtime, registry)
      }
      if (connectionId) {
        for (const previous of registry.values()) {
          if (previous.connectionId === connectionId) {
            previous.close()
          }
        }
      }
      if (registry.size >= 128) {
        throw new Error('review_subscription_capacity')
      }
      const id = `worktree-review:${randomUUID()}`
      const subscription = new WorkspaceReviewSubscription(runtime, {
        subscriptionId: id,
        selector: params.worktree,
        connectionId,
        requestId,
        emit,
        onClose: () => registry.delete(id),
        signal
      })
      if (signal?.aborted) {
        return
      }
      registry.set(id, subscription)
      try {
        emit({ type: 'ready', subscriptionId: id })
      } catch {
        subscription.close()
        return
      }
      await subscription.renew()
    }
  }),
  defineMethod({
    name: 'worktree.review.renew',
    permission: 'workspace',
    params: WorktreeReviewSubscription,
    handler: async (params, context) => {
      requireReviewStatusCapability(context)
      const { runtime, connectionId } = context
      const subscription = subscriptions.get(runtime)?.get(params.subscriptionId)
      return {
        renewed:
          !!subscription &&
          subscription.connectionId === connectionId &&
          (await subscription.renew())
      }
    }
  }),
  defineMethod({
    name: 'worktree.review.unsubscribe',
    permission: 'workspace',
    params: WorktreeReviewSubscription,
    handler: async (params, context) => {
      requireReviewStatusCapability(context)
      const { runtime, connectionId } = context
      const subscription = subscriptions.get(runtime)?.get(params.subscriptionId)
      const unsubscribed = !!subscription && subscription.connectionId === connectionId
      if (unsubscribed) {
        subscription.close()
      }
      return { unsubscribed }
    }
  })
]
