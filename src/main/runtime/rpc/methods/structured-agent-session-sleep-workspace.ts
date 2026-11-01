import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { defineMethod } from '../core'
import {
  requireInstalledStructuredHost as requireInstalledHost,
  requireStructuredCapability
} from './structured-agent-session-gate'
import { SleepWorkspaceParams } from './structured-agent-session-schemas'

export const STRUCTURED_AGENT_SESSION_SLEEP_WORKSPACE_METHODS = [
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
  })
]
