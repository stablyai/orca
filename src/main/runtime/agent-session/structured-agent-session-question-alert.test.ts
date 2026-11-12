import { expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { projectStructuredAgentSessionStatusState } from '../../../shared/agent-session/view/structured-agent-session-projection'
import { getDefaultNotificationSettings } from '../../../shared/notification-settings-defaults'
import { StructuredAgentSessionTurnCompletionFeed } from '../../native-chat/agent-session-wire/observations/structured-agent-session-turn-completion-feed'
import { createStructuredAttentionMobileDelivery } from './structured-agent-session-mobile-attention'
import type { MobileNotificationDispatchEvent } from '../push/notifications/runtime-mobile-notification-controller'

it.each(['question', 'approval'] as const)(
  'filters a host-recorded %s before headless phone delivery',
  (kind) => {
    const scope = {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'folder',
      workspaceKind: 'folder'
    } as const
    let items: AgentJournalRenderItem[] = [
      {
        itemId: 'user',
        revision: 0,
        sequence: 1,
        observedAt: 1,
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Start' }] }
      },
      {
        itemId: 'turn',
        revision: 0,
        sequence: 2,
        observedAt: 2,
        body: { kind: 'turn', turnId: 'turn', state: 'running' }
      }
    ]
    const sent: MobileNotificationDispatchEvent[] = []
    const delivery = createStructuredAttentionMobileDelivery({
      readNotificationSettings: () => ({
        ...getDefaultNotificationSettings(),
        agentQuestionsOnly: true,
        agentNeedsInput: kind === 'approval'
      }),
      readWorkspaceLabels: () => ({}),
      isWorkspaceMuted: () => false,
      readOrchestration: () => undefined,
      dispatch: (event) => sent.push(event),
      reconcile: () => {},
      now: () => 42
    })
    const feed = new StructuredAgentSessionTurnCompletionFeed({
      sessions: new Map([
        [
          'session',
          {
            journal: { cursor: () => ({ epoch: 'epoch', sequence: items.length }) },
            params: { location: scope }
          }
        ]
      ]),
      now: () => 42,
      readStatusState: () => projectStructuredAgentSessionStatusState(items),
      readChildWork: () => undefined
    })
    feed.subscribe({
      id: 'phone',
      includePrompts: true,
      emit: (event) => {
        if (event.type !== 'end') {
          delivery.deliver(event, undefined)
        }
      }
    })
    feed.observe('session')
    const resolution = {
      state: 'pending',
      selectedOptionId: null,
      resolvedBy: null,
      resolvedAt: null
    } as const
    items = [
      ...items,
      {
        itemId: 'prompt',
        revision: 0,
        sequence: 3,
        observedAt: 3,
        body:
          kind === 'question'
            ? { kind, question: 'Which branch?', options: [], resolution }
            : { kind, title: 'Run command?', detail: null, options: [], resolution }
      }
    ]
    feed.observe('session')
    expect(sent).toHaveLength(1)
    expect(sent[0]?.desktopAllowed !== false).toBe(kind === 'question')
  }
)
