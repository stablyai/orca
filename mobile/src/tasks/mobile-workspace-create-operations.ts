import { z } from 'zod'
import {
  isAgentLaunchResult,
  type AgentLaunchResult
} from '../../../src/shared/agent-launch-intent'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import {
  agentLaunchCreateReceiptSchema,
  worktreeCreateReceiptSchema,
  worktreeHostedBaseSchema
} from './workspace-create-reply-schema'
import { taskRuntimeStatusSchema } from './task-runtime-reply-schema'

// Replay receipts retain the full shared launch guard; create-time status shares the Tasks schema with different acceptance.

// Preserve the original delivery-unknown rejection so retries reuse clientMutationId after lost replies.
export const worktreeCreateRun = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'worktree.create',
    method: 'worktree.create',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('created-worktree', worktreeCreateReceiptSchema)
  })
)

// Launch-create shares the mutation id and lost-reply discipline with legacy worktree creation.
export const agentLaunchRun = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'agent.launch',
    method: 'agent.launch',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('agent-launch-receipt', agentLaunchCreateReceiptSchema)
  })
)

export const agentLaunchReplayRun = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'agent.launch-replay',
    method: 'agent.launchReplay',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('agent-launch-receipt', z.custom<AgentLaunchResult>(isAgentLaunchResult))
  })
)

export const worktreePrBaseResolve = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'worktree.resolve-pr-base',
    method: 'worktree.resolvePrBase',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('pr-start-point', worktreeHostedBaseSchema)
  })
)

export const worktreeMrBaseResolve = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'worktree.resolve-mr-base',
    method: 'worktree.resolveMrBase',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('mr-start-point', worktreeHostedBaseSchema)
  })
)

// Create-time status is advisory and may skip refusal; Tasks hydration requires the same reply to succeed.
export const worktreeCreateCapabilityRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'status.create-capabilities-or-skip',
    method: 'status.get',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('runtime-status', taskRuntimeStatusSchema)
  })
)

// Warmup refusal only loses a speed-up, including on older hosts without the method.
export const worktreeCreateBasePrefetch = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'worktree.prefetch-create-base-or-skip',
    method: 'worktree.prefetchCreateBase',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('create-base-prefetched', z.unknown())
  })
)
