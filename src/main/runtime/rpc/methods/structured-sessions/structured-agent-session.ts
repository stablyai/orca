import { STRUCTURED_AGENT_SESSION_ACCOUNT_USAGE_METHODS } from './catalog/structured-agent-session-account-usage'
import { STRUCTURED_AGENT_SESSION_USAGE_LIMIT_CONTINUE_METHODS } from './catalog/structured-agent-session-usage-limit-continue'
import { STRUCTURED_AGENT_SESSION_CLOSE_METHOD } from './conversation/structured-agent-session-close-method'
import { STRUCTURED_AGENT_SESSION_SUBSCRIBE_METHOD } from './subscriptions/structured-agent-session-subscribe-method'
import {
  clientReadsCurrentRequests,
  STRUCTURED_AGENT_SESSION_CURRENT_REQUESTS_METHODS
} from './conversation/structured-agent-session-current-requests'
import { clientSupportsSnapshotCatchUp } from './history/structured-agent-session-history-capability'
import { projectBackgroundTaskHistory } from './history/structured-agent-session-background-task-capability'
import { projectTurnItemHistory } from './history/structured-agent-session-turn-item-capability'
import { defineMethod } from '../../core'
import {
  ensureStructuredHostInstalled as ensureHostInstalled,
  requireInstalledStructuredHost as requireInstalledHost,
  requireStructuredCapability,
  requireStructuredCleanupHost,
  requireStructuredSessionHost as requireSessionHost,
  structuredCallerFor as callerFor
} from './creation/structured-agent-session-gate'
import {
  handleStructuredAgentSessionCreate,
  handleStructuredAgentSessionCreateSupport,
  attachClientSuppliedLocation
} from './creation/structured-agent-session-create-handler'
import { STRUCTURED_AGENT_SESSION_HOLD_METHODS } from './conversation/structured-agent-session-hold'
import { STRUCTURED_AGENT_SESSION_PROMPT_RESPONSE_METHODS } from './conversation/structured-agent-session-prompt-response'
import { STRUCTURED_AGENT_SESSION_REVEAL_METHODS } from './conversation/structured-agent-session-reveal'
import { STRUCTURED_AGENT_SESSION_REGENERATE_NAME_METHODS } from './conversation/structured-agent-session-regenerate-name'
import { STRUCTURED_AGENT_SESSION_RENAME_METHODS } from './conversation/structured-agent-session-rename'
import { STRUCTURED_AGENT_SESSION_QUEUED_METHODS } from './conversation/structured-agent-session-queued-methods'
import { STRUCTURED_AGENT_SESSION_RESTART_RESUME_METHODS } from './conversation/structured-agent-session-restart-resume'
import { STRUCTURED_AGENT_SESSION_STATUS_METHODS } from './subscriptions/structured-agent-session-status-stream'
import { structuredAgentSessionSubscriptionBase as subscriptionBaseFor } from './subscriptions/structured-agent-session-subscription-id'
import { STRUCTURED_AGENT_SESSION_TURN_COMPLETION_METHODS } from './subscriptions/structured-agent-session-turn-completion-stream'
import { STRUCTURED_AGENT_SESSION_THREAD_GOAL_METHODS } from './conversation/structured-agent-session-thread-goal'
import { STRUCTURED_AGENT_SESSION_CONVERSATION_OUTLINE_METHODS } from './history/structured-agent-session-conversation-outline'
import { STRUCTURED_AGENT_SESSION_ITEM_METHODS } from './history/structured-agent-session-item'
import { STRUCTURED_AGENT_SESSION_SEND_RECORDED_METHODS } from './history/structured-agent-session-send-recorded'
import { STRUCTURED_AGENT_SESSION_OPTIONS_READ_METHODS } from './catalog/structured-agent-session-options-read'
import {
  AttachParams,
  CancelParams,
  ConversationCommandParams,
  CreateParams,
  CreateSupportParams,
  HistoryParams,
  WorkStateParams,
  RewindParams,
  SendParams,
  SleepWorkspaceParams,
  UnsubscribeParams
} from '../../../../../shared/rpc-contract/structured-agent-session-params'
import '../../../../../shared/rpc-contract/structured-agent-session-continue-params'
import '../../../../../shared/rpc-contract/structured-agent-session-rename-params'
import '../../../../../shared/rpc-contract/structured-agent-session-queued-edit-params'
import { sendStructuredAgentSessionForClient } from './conversation/structured-agent-session-send-compatibility'
import { runConversationCommandForClient } from './conversation/structured-agent-session-conversation-command'
import { getStructuredAgentSessionHost } from '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../shared/layout-owner-switch'
import { refusingStructuredAgentSessionCreatesClosedFirst } from './creation/structured-agent-session-close-before-create'
import * as queuedImages from './attachments/structured-agent-session-queued-image-capability'
import { projectReceiptDeviceHistory } from './subscriptions/structured-agent-session-receipt-devices'

export const STRUCTURED_AGENT_SESSION_METHODS = [
  defineMethod({
    name: 'agentSession.rewind',
    permission: 'workspace',
    params: RewindParams,
    handler: async (params, ctx) => {
      requireStructuredCapability(ctx)
      await ensureHostInstalled(ctx)
      return requireSessionHost(ctx, params.envelope.sessionId).rewind(callerFor(ctx), params)
    }
  }),
  defineMethod({
    name: 'agentSession.conversationCommand',
    permission: 'workspace',
    params: ConversationCommandParams,
    handler: runConversationCommandForClient
  }),
  defineMethod({
    name: 'agentSession.createSupport',
    permission: 'workspace',
    params: CreateSupportParams,
    handler: handleStructuredAgentSessionCreateSupport
  }),
  defineMethod({
    name: 'agentSession.create',
    requires: ['accounts'],
    permission: 'workspace',
    params: CreateParams,
    handler: ORCA_LAYOUT_OWNER_IS_MAIN
      ? refusingStructuredAgentSessionCreatesClosedFirst(handleStructuredAgentSessionCreate)
      : handleStructuredAgentSessionCreate
  }),
  defineMethod({
    name: 'agentSession.ensure',
    permission: 'workspace',
    params: AttachParams,
    handler: async (params, ctx) => attachClientSuppliedLocation(params, ctx)
  }),
  defineMethod({
    name: 'agentSession.send',
    permission: 'workspace',
    params: SendParams,
    handler: sendStructuredAgentSessionForClient
  }),
  defineMethod({
    name: 'agentSession.cancel',
    permission: 'workspace',
    params: CancelParams,
    handler: async (params, ctx) => requireStructuredCleanupHost(ctx).cancel(callerFor(ctx), params)
  }),
  ...STRUCTURED_AGENT_SESSION_QUEUED_METHODS,
  STRUCTURED_AGENT_SESSION_CLOSE_METHOD,
  defineMethod({
    name: 'agentSession.sleepWorkspace',
    permission: 'workspace',
    params: SleepWorkspaceParams,
    handler: async (params, ctx) => {
      requireStructuredCapability(ctx)
      if (params.markAsleep) {
        return (await requireInstalledHost(ctx)).sleepWorkspace(params.workspaceId, true)
      }
      const installed = getStructuredAgentSessionHost()
      if (installed) {
        return installed.sleepWorkspace(params.workspaceId, params.markAsleep)
      }
      let store: Awaited<ReturnType<typeof ctx.runtime.openAgentSessionRecordStore>>
      try {
        store = await ctx.runtime.openAgentSessionRecordStore()
      } catch (error) {
        const appeared = getStructuredAgentSessionHost()
        if (appeared) {
          return appeared.sleepWorkspace(params.workspaceId, params.markAsleep)
        }
        console.warn('[agent-session] workspace sleep record inventory unavailable', error)
        return { stoppedSessionIds: [], failures: [{ reason: 'inventory-unavailable' }] }
      }
      const appeared = getStructuredAgentSessionHost()
      if (appeared) {
        return appeared.sleepWorkspace(params.workspaceId, params.markAsleep)
      }
      try {
        const records = store
          .listConversations()
          .filter(
            (record) =>
              record.location.workspaceId === params.workspaceId &&
              record.location.executionHostId === LOCAL_EXECUTION_HOST_ID
          )
        const stoppedSessionIds = records
          .filter((record) => record.neverStarted)
          .map((record) => record.sessionId)
        const failures = records
          .filter((record) => !record.neverStarted)
          .map((record) => ({ sessionId: record.sessionId, reason: 'stop-unverifiable' as const }))
        return failures.length > 0 ? { stoppedSessionIds, failures } : { stoppedSessionIds }
      } catch (error) {
        console.warn('[agent-session] workspace sleep record inventory failed', error)
        return { stoppedSessionIds: [], failures: [{ reason: 'inventory-unavailable' }] }
      }
    }
  }),
  ...STRUCTURED_AGENT_SESSION_PROMPT_RESPONSE_METHODS,
  defineMethod({
    name: 'agentSession.history',
    permission: 'workspace',
    params: HistoryParams,
    handler: async (params, ctx) => {
      const host = await requireInstalledHost(ctx, params.sessionId)
      return projectReceiptDeviceHistory(
        projectTurnItemHistory(
          queuedImages.projectQueuedImageCardHistory(
            projectBackgroundTaskHistory(
              await host.history(
                params,
                undefined,
                queuedImages.queuedImageHistoryReader(ctx),
                clientSupportsSnapshotCatchUp(ctx) && clientReadsCurrentRequests(ctx)
              ),
              ctx
            ),
            ctx
          ),
          ctx,
          host.sessionAgent(params.sessionId)
        ),
        ctx
      )
    }
  }),
  // Waiters poll this instead of history, so each check costs no transcript work.
  defineMethod({
    name: 'agentSession.workState',
    permission: 'workspace',
    params: WorkStateParams,
    handler: async (params, ctx) =>
      (await requireInstalledHost(ctx, params.sessionId)).backgroundTasks.workState(
        params.sessionId
      )
  }),
  STRUCTURED_AGENT_SESSION_SUBSCRIBE_METHOD,
  defineMethod({
    name: 'agentSession.unsubscribe',
    permission: 'workspace',
    params: UnsubscribeParams,
    handler: async (params, ctx) => {
      requireStructuredCleanupHost(ctx)
      const base = subscriptionBaseFor(ctx, params.sessionId)
      if (params.subscriptionId) {
        ctx.runtime.cleanupSubscription(`${base}:${params.subscriptionId}`)
        return { unsubscribed: true }
      }
      ctx.runtime.cleanupSubscription(base)
      ctx.runtime.cleanupSubscriptionsByPrefix(`${base}:`)
      return { unsubscribed: true }
    }
  }),
  ...STRUCTURED_AGENT_SESSION_HOLD_METHODS,
  ...STRUCTURED_AGENT_SESSION_REVEAL_METHODS,
  ...STRUCTURED_AGENT_SESSION_REGENERATE_NAME_METHODS,
  ...STRUCTURED_AGENT_SESSION_RENAME_METHODS,
  ...STRUCTURED_AGENT_SESSION_RESTART_RESUME_METHODS,
  ...STRUCTURED_AGENT_SESSION_USAGE_LIMIT_CONTINUE_METHODS,
  ...STRUCTURED_AGENT_SESSION_STATUS_METHODS,
  ...STRUCTURED_AGENT_SESSION_TURN_COMPLETION_METHODS,
  ...STRUCTURED_AGENT_SESSION_THREAD_GOAL_METHODS,
  ...STRUCTURED_AGENT_SESSION_CONVERSATION_OUTLINE_METHODS,
  ...STRUCTURED_AGENT_SESSION_ITEM_METHODS,
  ...STRUCTURED_AGENT_SESSION_SEND_RECORDED_METHODS,
  ...STRUCTURED_AGENT_SESSION_CURRENT_REQUESTS_METHODS,
  ...STRUCTURED_AGENT_SESSION_ACCOUNT_USAGE_METHODS,
  ...STRUCTURED_AGENT_SESSION_OPTIONS_READ_METHODS
]
