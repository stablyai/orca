import { isNativeLocalLocation } from '../../../../../../shared/execution-host/execution-host'
import type {
  AgentSessionSwarmReadResult,
  AgentSessionSwarmTranscriptResult
} from '../../../../../../shared/agent-session/antigravity-swarm-wire'
import {
  AgentSessionSwarmReadParams,
  AgentSessionSwarmTranscriptParams
} from '../../../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-swarm-params'
import {
  readAntigravitySwarmMemberTranscript,
  readAntigravitySwarmSnapshot
} from '../../../../../antigravity/antigravity-swarm-store'
import { defineMethod } from '../../../core'
import { requireInstalledStructuredHost } from '../creation/structured-agent-session-gate'

function failureMessage(error: unknown): string | null {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim()
  }
  return typeof error === 'string' && error.trim() ? error.trim() : null
}

export const STRUCTURED_AGENT_SESSION_SWARM_METHODS = [
  defineMethod({
    name: 'agentSession.swarmRead',
    permission: 'workspace',
    params: AgentSessionSwarmReadParams,
    handler: async ({ sessionId, ifNoneMatch }, ctx): Promise<AgentSessionSwarmReadResult> => {
      const host = await requireInstalledStructuredHost(ctx, sessionId)
      const saved = host.deps.store.getRecord(sessionId)
      if (!saved) {
        return { status: 'none' }
      }
      // Swarm artifacts live on the session's owning host; never read remote SSH or WSL homes from desktop fs.
      if (!isNativeLocalLocation(saved.location)) {
        return { status: 'unsupported' }
      }
      const accountHome = await host.deps.launchAccountHome?.(saved).catch(() => null)
      const record = accountHome ? { ...saved, accountHome } : saved
      try {
        return await readAntigravitySwarmSnapshot(record, { ifNoneMatch })
      } catch (error) {
        return { status: 'failed', message: failureMessage(error) }
      }
    }
  }),
  defineMethod({
    name: 'agentSession.swarmMemberTranscript',
    permission: 'workspace',
    params: AgentSessionSwarmTranscriptParams,
    handler: async (
      { sessionId, conversationId, maxEntries },
      ctx
    ): Promise<AgentSessionSwarmTranscriptResult> => {
      const host = await requireInstalledStructuredHost(ctx, sessionId)
      const saved = host.deps.store.getRecord(sessionId)
      if (!saved) {
        return { status: 'none' }
      }
      // Swarm artifacts live on the session's owning host; never read remote SSH or WSL homes from desktop fs.
      if (!isNativeLocalLocation(saved.location)) {
        return { status: 'unsupported' }
      }
      const accountHome = await host.deps.launchAccountHome?.(saved).catch(() => null)
      const record = accountHome ? { ...saved, accountHome } : saved
      try {
        return await readAntigravitySwarmMemberTranscript(record, { conversationId, maxEntries })
      } catch (error) {
        return { status: 'failed', message: failureMessage(error) }
      }
    }
  })
]
