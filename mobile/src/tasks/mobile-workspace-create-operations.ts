import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import {
  agentLaunchCreateReceiptSchema,
  worktreeCreateReceiptSchema,
  worktreeHostedBaseSchema
} from './workspace-create-reply-schema'
import { taskRuntimeStatusSchema } from './task-runtime-reply-schema'

// Creating a workspace from a task. Checked against workspace-create-reply-schema.ts; the
// create-time status probe reads through the Tasks screen's own status schema, because the two
// operations differ in acceptance and not in what the host sends.

/**
 * worktree.create. A lost reply is *unknown*, never failed — `worktree-create-retry.ts` replays on
 * the same clientMutationId — so this operation never interprets a transport rejection: `request`
 * hands back the transport promise itself and the delivery-unknown mark reaches the retry loop on
 * the original rejection object.
 */
export const worktreeCreateRun = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'worktree.create',
    method: 'worktree.create',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('created-worktree', worktreeCreateReceiptSchema)
  })
)

/**
 * agent.launch carrying a create payload: the host settles whether the agent lands in a structured
 * session or a terminal. Same reply discipline as worktreeCreateRun, and for the same reason — the
 * two share one clientMutationId, so the retry loop must see an unlost reply either way.
 */
export const agentLaunchRun = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'agent.launch',
    method: 'agent.launch',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('agent-launch-receipt', agentLaunchCreateReceiptSchema)
  })
)

/**
 * The start point for a workspace created from a linked pull request. Refusal throws the host's
 * message; an accepted reply can still carry a soft `{ error }` the caller raises itself.
 */
export const worktreePrBaseResolve = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'worktree.resolve-pr-base',
    method: 'worktree.resolvePrBase',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('pr-start-point', worktreeHostedBaseSchema)
  })
)

/** The GitLab merge-request equivalent; same acceptance, same soft-error convention. */
export const worktreeMrBaseResolve = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'worktree.resolve-mr-base',
    method: 'worktree.resolveMrBase',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('mr-start-point', worktreeHostedBaseSchema)
  })
)

/**
 * status.get read for create-time capabilities, with its own policy on that method.
 *
 * Separately named because the callers disagree about what a refused status means: the
 * Tasks screen cannot hydrate without it and surfaces the host's message (`taskRuntimeStatusRead`),
 * while create-time capability probing degrades to "no capabilities" and creates anyway, so here a
 * refusal is a skip. One reader serves both, and it is now the same checked schema in each.
 */
export const worktreeCreateCapabilityRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'status.create-capabilities-or-skip',
    method: 'status.get',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('runtime-status', taskRuntimeStatusSchema)
  })
)
