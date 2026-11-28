import { randomUUID } from 'node:crypto'
import { refuse } from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import type { AgentSessionMutationEnvelope } from '../../../../shared/agent-session/agent-session-wire'
import type { AgentJournalMessageItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'

const PREFIX = 'slack-exec-'
const EXECUTION_ID = /^slack-exec-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/

export const createSlackExecutionId = () => `${PREFIX}${randomUUID()}`
export const isSlackExecutionId = (id: string) => id.startsWith(PREFIX)
export const isValidSlackExecutionId = (id: string) => EXECUTION_ID.test(id)

export type SlackExecutionLaunch = {
  launchDirectory(): Promise<string>
  instructions(): Promise<string>
  memory?: SlackExecutionMemory
}

export type SlackExecutionMemory = {
  read(): Promise<{ index: string | null; topics: string[] }>
  readTopic(topic: string): Promise<string | null>
  remember(fact: string, date: string, topic?: string): Promise<boolean>
  forget(fact: string, topic?: string): Promise<boolean>
}

export type SlackExecutionSend = {
  envelope: AgentSessionMutationEnvelope
  body: AgentJournalMessageItem
  beforeRun?: () => void | Promise<void>
  delivery?: 'queue-if-active'
}

const connectorAdmissions = new WeakMap<NonNullable<SlackExecutionSend['beforeRun']>, string>()

/** Only the connector's in-process callback can authorize a scoped send. */
export function authorizeSlackExecutionSend(sessionId: string, run: () => void): () => void {
  connectorAdmissions.set(run, sessionId)
  return run
}

export function hasSlackExecutionSendAuthority(params: SlackExecutionSend): boolean {
  return (
    !!params.beforeRun && connectorAdmissions.get(params.beforeRun) === params.envelope.sessionId
  )
}

export const slackExecutionMutationRefusal = () => ({
  ok: false as const,
  refusal: refuse(
    'agent_session_operation_invalid',
    { reason: 'requestMalformed' },
    'This Slack execution accepts only its original connector delivery.'
  )
})
