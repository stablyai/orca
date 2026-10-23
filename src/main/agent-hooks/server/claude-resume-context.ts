import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import {
  isSameAgentProcess,
  type AgentProcessIdentity
} from '../../../shared/agent-process-presence'
import {
  claudeResumeOriginsEqual,
  type ClaudeResumeOrigin
} from '../../../shared/claude-resume-origin'
import { claudeResumeConfigsEqual } from '../../../shared/claude-resume-config'
import type { AgentProviderSessionMetadata } from '../../../shared/agent-session-resume'

export function readAdmittedClaudeResumeConfig(
  rows: Iterable<AgentHookEventPayload>,
  requested: AgentProviderSessionMetadata,
  origin: ClaudeResumeOrigin
) {
  for (const row of rows) {
    const session = row.providerSession
    if (
      row.payload.agentType === 'claude' &&
      row.source === 'claude' &&
      session?.claudeConfig &&
      session.key === requested.key &&
      session.id === requested.id &&
      session.transcriptPath === requested.transcriptPath &&
      claudeResumeConfigsEqual(session.claudeConfig, requested.claudeConfig) &&
      claudeResumeOriginsEqual(session.claudeConfigOrigin, origin)
    ) {
      return session.claudeConfig
    }
  }
  return undefined
}

export function bindClaudeResumeContext<T extends AgentHookEventPayload>(
  row: T,
  previous: AgentHookEventPayload | undefined,
  origin: ClaudeResumeOrigin | undefined,
  sameExecution: boolean,
  newRun: boolean,
  sender: AgentProcessIdentity | undefined = row.agentPresence?.process
): T {
  if (row.payload.agentType !== 'claude') {
    return row
  }
  const providerSession = row.providerSession
  const oldSession = previous?.payload.agentType === 'claude' ? previous.providerSession : undefined
  const oldProcess = previous?.agentPresence?.process
  const matchesOwningProcess =
    !oldProcess ||
    !sender ||
    previous?.agentPresence?.ended === true ||
    isSameAgentProcess(oldProcess, sender)
  const sameSession =
    !newRun &&
    sameExecution &&
    oldSession &&
    row.launchToken !== undefined &&
    row.launchToken === previous?.launchToken &&
    row.connectionId === previous?.connectionId &&
    row.worktreeId === previous?.worktreeId &&
    matchesOwningProcess &&
    (!providerSession ||
      (providerSession.key === oldSession.key && providerSession.id === oldSession.id))
  const preserved =
    sameSession &&
    oldSession.claudeConfig &&
    oldSession.claudeConfigOrigin &&
    claudeResumeOriginsEqual(oldSession.claudeConfigOrigin, origin)
      ? oldSession
      : undefined
  const session = providerSession ?? (sameSession ? oldSession : undefined)
  if (!session) {
    return row
  }
  const { claudeConfig: _config, claudeConfigOrigin: _origin, ...identity } = session
  const transcriptPath =
    identity.transcriptPath ?? (sameSession ? oldSession.transcriptPath : undefined)
  const observedConfig =
    row.source === 'claude' &&
    row.hookEventName &&
    matchesOwningProcess &&
    (row.isReplay !== true || !preserved)
      ? providerSession?.claudeConfig
      : undefined
  const config = observedConfig ?? preserved?.claudeConfig
  const boundOrigin = observedConfig ? origin : preserved?.claudeConfigOrigin
  const boundSession =
    config && boundOrigin
      ? {
          ...identity,
          ...(transcriptPath ? { transcriptPath } : {}),
          claudeConfig: config,
          claudeConfigOrigin: boundOrigin
        }
      : { ...identity, ...(transcriptPath ? { transcriptPath } : {}) }
  return { ...row, providerSession: boundSession }
}
