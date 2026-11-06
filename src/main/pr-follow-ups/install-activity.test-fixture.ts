import { vi } from 'vitest'
import type { AgentPaneChange } from '../agent-hooks/agent-transition-detector'
import type { AgentSessionStatusEvent } from '../../shared/agent-session/agent-session-wire'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'

export function installationActivity(surface: 'chat' | 'terminal', now: number, initial: boolean) {
  let transition!: (event: AgentPaneChange) => void
  let chatEmit: ((event: AgentSessionStatusEvent) => void) | undefined
  const chatSession = (identity: string, active: boolean, at: number, workspaceId = 'w0') => ({
    sessionId: identity,
    workspaceId,
    agent: 'codex',
    status: active ? ('working' as const) : ('idle' as const),
    latestPrompt: '',
    updatedAt: at,
    statusStartedAt: at
  })
  vi.mocked(getStructuredAgentSessionHost).mockReturnValue(
    surface === 'chat'
      ? ({
          subscribeStatus: (sink: { emit(event: AgentSessionStatusEvent): void }) => {
            chatEmit = sink.emit
            if (initial) {
              sink.emit({ type: 'snapshot', sessions: [chatSession('pane-w0', false, now + 10)] })
            }
            return () => {}
          }
        } as unknown as NonNullable<ReturnType<typeof getStructuredAgentSessionHost>>)
      : null
  )
  return {
    subscribe: (listener: typeof transition) => {
      transition = listener
      if (initial) {
        listener({
          kind: 'seeded',
          workspace: { worktreeId: 'w0', sshHostId: null },
          paneKey: 'pane-w0',
          phase: 'done',
          at: now + 10
        })
      }
      return () => {}
    },
    stream: (identity: string, active: boolean, at: number, workspaceId = 'w0') => {
      if (surface === 'chat') {
        chatEmit?.({ type: 'status', session: chatSession(identity, active, at, workspaceId) })
      } else {
        transition({
          kind: 'moved',
          workspace: { worktreeId: workspaceId, sshHostId: null },
          paneKey: identity,
          from: active ? 'done' : 'working',
          to: active ? 'working' : 'done',
          transition: null,
          at
        })
      }
    }
  }
}
