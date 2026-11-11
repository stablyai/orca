import { defineMethod } from '../../core'
import {
  RecordedAgentSessionsParams,
  ResumeRecordedAgentSessionParams
} from '../../../../../shared/rpc-contract/recorded-agent-session-params'

export const RECORDED_AGENT_SESSION_METHODS = [
  defineMethod({
    name: 'agent.sessions',
    permission: 'workspace',
    params: RecordedAgentSessionsParams,
    handler: (params, { runtime }) => runtime.listRecordedAgentSessions(params.worktree)
  }),
  defineMethod({
    name: 'agent.resume',
    requires: ['accounts'],
    permission: 'workspace',
    params: ResumeRecordedAgentSessionParams,
    handler: (params, { runtime }) =>
      runtime.resumeRecordedAgentSession(
        params.worktree,
        params.paneKey
          ? { paneKey: params.paneKey, agent: params.agent, sessionId: params.sessionId }
          : { agent: params.agent!, sessionId: params.sessionId! }
      )
  })
]
