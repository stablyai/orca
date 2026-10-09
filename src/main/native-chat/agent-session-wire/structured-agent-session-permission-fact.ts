import {
  agentChatPermissionModes,
  agentChatLaunchPermissionMode,
  type AgentSessionPermissionFact,
  type AgentSessionPermissionModes
} from '../../../shared/agent-chat-permission-mode'
import { codexChatPermissionOptions } from '../../codex/codex-structured-permission-mode'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'

export function restingPermissionModes(
  record: AgentSessionRecord,
  logger?: StructuredAgentSessionHostDeps['logger']
): AgentSessionPermissionModes | null | undefined {
  try {
    const supported = agentChatPermissionModes(record.provider)
    const options =
      record.provider === 'codex' ? codexChatPermissionOptions(record.options) : record.options
    const current = agentChatLaunchPermissionMode(record.provider, options, undefined)
    return supported && current ? { current, supported } : null
  } catch (error) {
    logger?.warn('reading chat permissions failed', {
      scope: 'permission-fact',
      sessionId: record.sessionId,
      error
    })
    return undefined
  }
}

/** Permission metadata is optional; its failure never blocks transcript delivery. */
export function readStructuredAgentSessionPermissionFact(
  deps: Pick<StructuredAgentSessionHostDeps, 'store' | 'logger'>,
  sessionId: string
): AgentSessionPermissionFact | undefined {
  try {
    const record = deps.store.getRecord(sessionId)
    if (!record) {
      return undefined
    }
    const permission = restingPermissionModes(record, deps.logger)
    return permission === undefined
      ? undefined
      : {
          mode: permission?.current ?? null,
          fence: record.lease.runtimeFence,
          revision: deps.store.permissionRevision(sessionId)
        }
  } catch (error) {
    deps.logger.warn('reading chat permissions failed', {
      scope: 'permission-fact',
      sessionId,
      error
    })
    return undefined
  }
}
