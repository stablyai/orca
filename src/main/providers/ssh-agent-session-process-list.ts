import { isAgentSessionOwnerBinding } from '../../shared/agent-session-host-authority'
import { isPtyIncarnationId } from '../../shared/pty-incarnation'
import type { PtyProcessInfo } from './types'

export function mapSshPtyProcessList(
  sessions: PtyProcessInfo[],
  toAppPtyId: (id: string) => string
): PtyProcessInfo[] {
  return sessions.map((session) => {
    if (session.agentSessionOwners?.length && !isPtyIncarnationId(session.incarnationId)) {
      throw new Error('agent_session_ownership_unknown')
    }
    return {
      ...session,
      id: toAppPtyId(session.id),
      ...(session.agentSessionOwners
        ? {
            agentSessionOwners: session.agentSessionOwners.map((owner) => {
              if (!isAgentSessionOwnerBinding(owner) || owner.ptyId !== session.id) {
                throw new Error('agent_session_ownership_unknown')
              }
              return { ...owner, ptyId: toAppPtyId(owner.ptyId) }
            })
          }
        : {})
    }
  })
}
