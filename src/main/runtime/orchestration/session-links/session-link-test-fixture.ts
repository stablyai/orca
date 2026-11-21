import { SessionLinkParticipant } from '../../../../shared/session-link'

export const sessionLinkTestParticipants: [SessionLinkParticipant, SessionLinkParticipant] = [
  SessionLinkParticipant.parse({
    sessionId: 'claude_review',
    conversationId: 'claude_review',
    role: 'reviewer',
    name: 'Review',
    agent: 'claude',
    workspaceId: 'repo::/work/review',
    directory: '/work/review',
    branch: 'design',
    task: 'Review',
    context: ''
  }),
  SessionLinkParticipant.parse({
    sessionId: 'codex_implement',
    conversationId: 'codex_implement',
    role: 'implementer',
    name: 'Implement',
    agent: 'codex',
    workspaceId: 'repo::/work/implement',
    directory: '/work/implement',
    branch: 'feature',
    task: 'Implement',
    context: ''
  })
]
