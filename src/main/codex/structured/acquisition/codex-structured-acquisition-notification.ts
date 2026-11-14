import { readRecord } from '../../app-server/codex-item-field-readers'
import { readCodexCumulativeUsage } from '../journal/codex-context-usage'
import type { CodexAppServerConnectionHandlers } from '../../app-server/codex-app-server-connection-types'
import type { CodexAcquisitionWindow } from './codex-structured-acquisition-window'
import type { CodexDispatchEchoes } from '../turns/codex-structured-dispatch-echo'
import type { CodexStructuredNotificationRetry } from '../session-lifecycle/codex-structured-notification-retry'
import {
  codexThreadIsActive,
  codexThreadStoppedRunning,
  readCodexThreadId
} from '../../app-server/codex-structured-thread-facts'

/** Boundaries retain host receipt time through buffering and retries. */
const CODEX_RECEIPT_TIMED_METHODS: ReadonlySet<string> = new Set([
  'turn/started',
  'turn/completed',
  'item/started',
  'item/completed'
])

/** Stamp provider receipt before pre-publication buffering or retry. */
export function codexAcquisitionNotificationHandler(input: {
  acquisition: CodexAcquisitionWindow
  sessionId: string
  dispatchEchoes: CodexDispatchEchoes
  primaryThreadId: () => string | null
  notificationRetries: CodexStructuredNotificationRetry
  deliver: (
    acquisition: CodexAcquisitionWindow,
    sessionId: string,
    event: () => unknown,
    retainedBytes?: number
  ) => void
  now: () => number
}): NonNullable<CodexAppServerConnectionHandlers['onNotification']> {
  return (method, params) => {
    if (method === 'account/updated') {
      input.acquisition.authRevision += 1
      input.acquisition.usageMeter.invalidate()
      if (input.acquisition.execution?.inputAdmitted) {
        input.acquisition.execution.invalidated = true
        input.acquisition.execution.controls.stop()
        input.acquisition.execution.checkpoint?.()
      }
    }
    const observedAt = CODEX_RECEIPT_TIMED_METHODS.has(method) ? input.now() : undefined
    const dispatchSequenceAtReceipt =
      method === 'turn/started' ? input.dispatchEchoes.latestSequence() : undefined
    // Stamp status on receipt so buffering cannot reorder it relative to replies.
    const threadId = readCodexThreadId(params)
    const execution = input.acquisition.execution
    if (threadId && threadId === input.primaryThreadId()) {
      if (method === 'thread/tokenUsage/updated') {
        input.acquisition.usageMeter.observe(params, threadId, input.now())
      } else if (method === 'turn/started') {
        input.acquisition.usageMeter.started()
      } else if (method === 'turn/completed') {
        input.acquisition.usageMeter.activity(true)
      } else if (method === 'thread/status/changed') {
        input.acquisition.usageMeter.activity(codexThreadStoppedRunning(params))
      }
    }
    if (
      execution?.inputAdmitted &&
      !execution.usageUnverifiable &&
      method === 'thread/tokenUsage/updated' &&
      threadId &&
      threadId === input.primaryThreadId()
    ) {
      execution.usage = readCodexCumulativeUsage(params, threadId, input.now(), execution.usage)
      if (!execution.usage) {
        execution.usageUnverifiable = true
      }
      execution.checkpoint?.()
    }
    if (
      execution?.inputAdmitted &&
      method === 'turn/completed' &&
      threadId === input.primaryThreadId() &&
      readRecord(readRecord(params).turn).status === 'completed'
    ) {
      execution.turnCompleted = true
      execution.checkpoint?.()
      execution.controls.stop()
    }
    if (method === 'thread/status/changed' && threadId && threadId === input.primaryThreadId()) {
      input.dispatchEchoes.observeStatus(codexThreadIsActive(params))
    }
    if (method === 'thread/settings/updated' && threadId && threadId === input.primaryThreadId()) {
      const settings = readRecord(readRecord(params).threadSettings)
      const execution = input.acquisition.execution
      const previous = input.acquisition.nativeExecutionSettings
      const sandbox = readRecord(settings.sandboxPolicy)
      if (
        execution?.inputAdmitted &&
        (settings.model !== execution.policy.model ||
          settings.effort !== execution.policy.effort ||
          settings.cwd !== previous?.cwd ||
          settings.modelProvider !== 'openai' ||
          readRecord(settings.activePermissionProfile).id !== execution.profileId ||
          settings.approvalPolicy !== 'never' ||
          settings.approvalsReviewer !== 'user' ||
          sandbox.networkAccess !== false ||
          sandbox.type !==
            (execution.policy.access === 'workspace' ? 'workspaceWrite' : 'readOnly'))
      ) {
        execution.invalidated = true
        execution.controls.stop()
        execution.checkpoint?.()
      }
      input.acquisition.nativeExecutionSettings = settings
      input.acquisition.usageMeter.settings(settings)
      if (
        typeof settings.model === 'string' &&
        (typeof settings.effort === 'string' || settings.effort === null)
      ) {
        input.acquisition.appliedSettings.observe(settings)
      }
    }
    input.deliver(
      input.acquisition,
      input.sessionId,
      () =>
        input.notificationRetries.handle(
          input.sessionId,
          method,
          params,
          observedAt,
          dispatchSequenceAtReceipt
        ),
      Buffer.byteLength(JSON.stringify(params ?? null), 'utf8')
    )
  }
}
