import type { Session } from './session'
import type {
  AgentPresenceCaptureOptions,
  AgentProcessIdentity
} from '../../shared/agent-process-presence'

export async function captureSessionAgentPresence(
  sessions: ReadonlyMap<string, Session>,
  id: string,
  options?: AgentPresenceCaptureOptions
) {
  const session = sessions.get(id)
  if (!session?.isAlive) {
    return undefined
  }
  const presence = await session.captureAgentPresence(options)
  return sessions.get(id) === session && session.isAlive ? presence : undefined
}

export async function probeSessionAgentPresence(
  sessions: ReadonlyMap<string, Session>,
  id: string,
  identity: AgentProcessIdentity
) {
  const session = sessions.get(id)
  return session?.isAlive ? session.probeAgentPresence(identity) : ('unverifiable' as const)
}

export function readSessionForeground(sessions: ReadonlyMap<string, Session>, id: string) {
  const session = sessions.get(id)
  return session?.isAlive ? session.getForegroundProcess() : null
}
