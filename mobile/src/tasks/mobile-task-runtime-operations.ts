import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import {
  taskLinearStatusSchema,
  taskPreferenceWriteSchema,
  taskPreflightSchema,
  taskRuntimeStatusSchema,
  taskUiStateSchema
} from './task-runtime-reply-schema'

// What the Tasks screen reads once per host to hydrate, and the preferences it writes back.
//
// Readers are checked against task-runtime-reply-schema.ts. The three writes read `z.unknown()`
// there: no call site interprets their body, so a requirement would have no reader behind it.

/**
 * status.get read for task hydration, with its own policy on that method: a refused status stops
 * hydration with the host's own message, where the create-time probe in
 * mobile-workspace-create-operations.ts degrades instead. One reader serves both.
 */
export const taskRuntimeStatusRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'status.task-runtime',
    method: 'status.get',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('runtime-status', taskRuntimeStatusSchema)
  })
)

/**
 * Persisted UI state, read at the hydration barrier alongside preflight and Linear status. A
 * refused read leaves the screen on its defaults rather than failing hydration, so it is a skip.
 */
export const taskUiStateRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'ui.task-state-or-skip',
    method: 'ui.get',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('ui-state-member', taskUiStateSchema)
  })
)

/** Whether `glab` is installed, which gates the GitLab provider. Advisory, so refusal skips. */
export const taskPreflightRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'preflight.task-tooling-or-skip',
    method: 'preflight.check',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('task-preflight', taskPreflightSchema)
  })
)

/** Whether Linear is connected. Also advisory: an unanswered probe means "not connected". */
export const taskLinearStatusRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'linear.task-status-or-skip',
    method: 'linear.status',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('linear-status', taskLinearStatusSchema)
  })
)

/**
 * Writing persisted UI state. Two of its three call sites await it and surface the host's refusal
 * message; the third is fire-and-forget and never interprets the reply, so no acceptance applies
 * there. The payload is unread either way.
 */
export const taskUiStateWrite = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'ui.set-task-state',
    method: 'ui.set',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('ui-state-written', taskPreferenceWriteSchema)
  })
)

/**
 * Writing a host setting from the Tasks screen. Every call site is best-effort — the in-memory
 * picker already reflects the change — so a refusal is a skip, and none of them reads the payload.
 */
export const taskSettingsWrite = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'settings.update-task-preference-or-skip',
    method: 'settings.update',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('setting-written', taskPreferenceWriteSchema)
  })
)

/**
 * Switching the connected Linear workspace from the filter sheet.
 *
 * Declared but never interpreted, and deliberately: the picker chains `loadLinearContext` off the
 * send without reading the reply, so a refused switch reloads the context exactly as an accepted
 * one does and only a transport rejection reaches the error copy. Interpreting here would make a
 * refusal visible for the first time, which is a product change and not this one. See
 * unvalidated-rpc-request-port-inventory.ts for the ticket. The checked reader keeps that: its
 * schema is `z.unknown()`, so no payload can make this site fail where main's did not.
 */
export const linearWorkspaceSelect = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'linear.select-workspace-or-skip',
    method: 'linear.selectWorkspace',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('linear-workspace-selection', taskPreferenceWriteSchema)
  })
)
