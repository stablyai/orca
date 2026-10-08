import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../shared/agent-session-journal-types'
import { agentSessionPromptAttentionKey } from '../../shared/agent-session-attention'
import type { AgentSessionTurnCompletionEvent } from '../../shared/agent-session-wire'
import { projectStructuredAgentSessionStatusState } from '../../shared/structured-agent-session-projection'
import { StructuredAgentSessionTurnCompletionFeed } from '../native-chat/agent-session-wire/structured-agent-session-turn-completion-feed'
import {
  RuntimeMobileNotificationController,
  type MobileNotificationEvent
} from './runtime-mobile-notification-controller'
import { createStructuredAttentionMobileDelivery } from './structured-agent-session-mobile-attention'

const SCOPE = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'workspace-1',
  workspaceKind: 'git-worktree'
} as const

const USER: AgentJournalRenderItem = {
  itemId: 'user-1',
  revision: 0,
  sequence: 1,
  observedAt: 1,
  body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Run the migration' }] }
}

function turn(outcome?: 'success' | 'failure'): AgentJournalRenderItem {
  return {
    itemId: 'turn-item',
    revision: outcome ? 2 : 1,
    sequence: 2,
    observedAt: 2,
    body: {
      kind: 'turn',
      turnId: 'turn-1',
      state: outcome ? 'completed' : 'running',
      ...(outcome ? { outcome } : {})
    }
  }
}

function approval(resolved: boolean): AgentJournalRenderItem {
  return {
    itemId: 'approval-1',
    revision: resolved ? 2 : 1,
    sequence: 3,
    observedAt: 3,
    agentId: 'child-1',
    body: {
      kind: 'approval',
      title: 'Run command?',
      detail: null,
      options: [{ id: 'yes', label: 'Allow' }],
      resolution: {
        state: resolved ? 'resolved' : 'pending',
        selectedOptionId: null,
        resolvedBy: null,
        resolvedAt: null
      }
    }
  }
}

describe('host prompt delivery and retirement', () => {
  it.each([
    ['success', false],
    ['success', true],
    ['failure', false],
    ['failure', true]
  ] as const)(
    'withdraws the prompt beside %s (announced earlier: %s)',
    (outcome, announcedEarlier) => {
      const directory = mkdtempSync(join(tmpdir(), 'orca-prompt-retirement-'))
      try {
        let items = [USER, turn()]
        let sequence = 1
        const events: MobileNotificationEvent[] = []
        const legacy: AgentSessionTurnCompletionEvent[] = []
        const controller = new RuntimeMobileNotificationController()
        controller.configureDismissalStore(directory)
        controller.onDispatched((event) => events.push(event))
        const delivery = createStructuredAttentionMobileDelivery({
          readNotificationSettings: () => ({
            enabled: true,
            agentTaskComplete: true,
            terminalBell: true,
            suppressWhenFocused: false,
            customSoundId: 'system',
            customSoundPath: null,
            customSoundVolume: 1,
            mutedNotificationSourceIds: []
          }),
          readWorkspaceLabels: () => ({}),
          dispatch: (event) => controller.dispatch(event),
          reconcile: (state) => controller.reconcileStructuredPromptAttention(state),
          now: () => 42
        })
        const feed = new StructuredAgentSessionTurnCompletionFeed({
          sessions: new Map([
            [
              'session-1',
              {
                journal: { cursor: () => ({ epoch: 'epoch-1', sequence }) },
                params: { location: SCOPE }
              }
            ]
          ]),
          readStatusState: () => projectStructuredAgentSessionStatusState(items),
          now: () => 42
        })
        feed.subscribe({ id: 'legacy', emit: (event) => legacy.push(event) })
        feed.subscribe({
          id: 'host-mobile',
          includePrompts: true,
          emit: (event) => {
            if (event.type !== 'end') {
              delivery.deliver(event, undefined)
            }
          },
          onState: delivery.reconcile
        })
        feed.observe('session-1')
        if (announcedEarlier) {
          items = [USER, turn(), approval(false)]
          sequence += 1
          feed.observe('session-1')
        }
        items = [USER, turn(outcome), approval(false)]
        sequence += 1
        feed.observe('session-1')
        feed.observe('session-1')
        const key = agentSessionPromptAttentionKey(SCOPE, 'session-1', 'approval-1')
        const promptAnnounced = outcome === 'success' || announcedEarlier
        expect(legacy).toEqual([
          expect.objectContaining({
            type: 'completion',
            completion: expect.objectContaining({ outcome, awaitingUser: true })
          })
        ])
        expect(
          events
            .filter((event) => event.type === 'notification' && event.agentState === 'blocked')
            .map((event) => event.notificationId)
        ).toEqual(promptAnnounced ? [key] : [])
        const failures = events
          .filter((event) => event.type === 'notification')
          .filter((event) => event.agentState === 'done')
        expect(failures).toHaveLength(outcome === 'failure' ? 1 : 0)
        if (outcome === 'failure') {
          expect(failures[0]?.title).toContain('failed')
        }
        items = [USER, turn(outcome), approval(true)]
        sequence += 1
        feed.observe('session-1')
        feed.observe('session-1')
        expect(
          events.filter((event) => event.type === 'dismiss').map((event) => event.notificationId)
        ).toEqual(promptAnnounced ? [key] : [])
        expect(events.filter((event) => event.type === 'notification')).toHaveLength(
          Number(promptAnnounced) + (outcome === 'failure' ? 1 : 0)
        )
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }
  )
})
