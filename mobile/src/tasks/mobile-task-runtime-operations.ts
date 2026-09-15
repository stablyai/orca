import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import {
  rpcUncheckedMemberReader,
  rpcUncheckedPayloadReader
} from '../transport/rpc-reader-payload'

// What the Tasks screen reads once per host to hydrate, and the preferences it writes back.

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
    read: rpcUncheckedPayloadReader('runtime-status')
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
    read: rpcUncheckedMemberReader('ui-state-member', 'ui')
  })
)

/** Whether `glab` is installed, which gates the GitLab provider. Advisory, so refusal skips. */
export const taskPreflightRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'preflight.task-tooling-or-skip',
    method: 'preflight.check',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('task-preflight')
  })
)

/** Whether Linear is connected. Also advisory: an unanswered probe means "not connected". */
export const taskLinearStatusRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'linear.task-status-or-skip',
    method: 'linear.status',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('linear-status')
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
    read: rpcUncheckedPayloadReader('ui-state-written')
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
    read: rpcUncheckedPayloadReader('setting-written')
  })
)
