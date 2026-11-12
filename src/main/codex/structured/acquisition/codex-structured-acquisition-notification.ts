import { readRecord } from '../../app-server/codex-item-field-readers'
import type { CodexAppServerConnectionHandlers } from '../../app-server/codex-app-server-connection-types'
import type { CodexAcquisitionWindow } from './codex-structured-acquisition-window'
import type { CodexDispatchEchoes } from '../turns/codex-structured-dispatch-echo'
import type { CodexStructuredNotificationRetry } from '../session-lifecycle/codex-structured-notification-retry'
import { CODEX_RECEIPT_TIMED_METHODS } from '../session-lifecycle/codex-structured-session-state'
import {
  codexThreadIsActive,
  readCodexThreadId
} from '../../app-server/codex-structured-thread-facts'

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
      if (input.acquisition.execution?.inputAdmitted) {
        input.acquisition.execution.controls.stop()
      }
    }
    const observedAt = CODEX_RECEIPT_TIMED_METHODS.has(method) ? input.now() : undefined
    const dispatchSequenceAtReceipt =
      method === 'turn/started' ? input.dispatchEchoes.latestSequence() : undefined
    // Stamp status on receipt so buffering cannot reorder it relative to replies.
    const threadId = readCodexThreadId(params)
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
        execution.controls.stop()
      }
      input.acquisition.nativeExecutionSettings = settings
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
