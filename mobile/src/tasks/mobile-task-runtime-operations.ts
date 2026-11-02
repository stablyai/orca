import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import {
  taskLinearStatusSchema,
  taskPreferenceWriteSchema,
  taskPreflightSchema,
  taskRuntimeStatusSchema,
  taskUiStateSchema
} from './task-runtime-reply-schema'

// Task hydration requires status; create-time capability probing may skip the same method’s refusal.
export const taskRuntimeStatusRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'status.task-runtime',
    method: 'status.get',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('runtime-status', taskRuntimeStatusSchema)
  })
)

// Persisted UI state is advisory; refusal retains screen defaults.
export const taskUiStateRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'ui.task-state-or-skip',
    method: 'ui.get',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('ui-state-member', taskUiStateSchema)
  })
)

export const taskPreflightRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'preflight.task-tooling-or-skip',
    method: 'preflight.check',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('task-preflight', taskPreflightSchema)
  })
)

export const taskLinearStatusRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'linear.task-status-or-skip',
    method: 'linear.status',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('linear-status', taskLinearStatusSchema)
  })
)

// Awaited writes surface refusal; fire-and-forget calls consume neither acceptance nor payload.
export const taskUiStateWrite = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'ui.set-task-state',
    method: 'ui.set',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('ui-state-written', taskPreferenceWriteSchema)
  })
)

// Settings writes are best-effort because the picker already reflects the local change.
export const taskSettingsWrite = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'settings.update-task-preference-or-skip',
    method: 'settings.update',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('setting-written', taskPreferenceWriteSchema)
  })
)

// Preserve legacy acceptance: switch refusal still reloads Linear context; only transport rejection reaches error copy.
export const linearWorkspaceSelect = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'linear.select-workspace-or-skip',
    method: 'linear.selectWorkspace',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('linear-workspace-selection', taskPreferenceWriteSchema)
  })
)
