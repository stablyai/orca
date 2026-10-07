import { describe, expect, it, vi } from 'vitest'
import {
  agentSessionAttentionKey,
  type AgentSessionAttentionEdge,
  type StructuredAttentionState
} from '../../shared/agent-session-attention'
import type { AgentSessionStatusSummary } from '../../shared/agent-session-wire'
import type { NotificationSettings } from '../../shared/notification-settings-types'
import {
  createStructuredAttentionMobileDelivery,
  readStructuredAttentionWorkspaceLabels,
  type StructuredAttentionMobileDeliveryDeps
} from './structured-agent-session-mobile-attention'
import type { MobileNotificationDispatchEvent } from './runtime-mobile-notification-controller'

const SCOPE = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'repo-1::/work/feature',
  workspaceKind: 'git-worktree'
} as const

const PROMPT: AgentSessionAttentionEdge = {
  type: 'prompt',
  prompt: { scope: SCOPE, sessionId: 'session-1', promptId: 'approval-1', raisedAt: 1 }
}

function completion(
  outcome: 'success' | 'failure',
  awaitingUser?: true
): AgentSessionAttentionEdge {
  return {
    type: 'completion',
    completion: {
      scope: SCOPE,
      sessionId: 'session-1',
      turnId: 'turn-1',
      outcome,
      completedAt: 1,
      ...(awaitingUser ? { awaitingUser } : {})
    }
  }
}

const SUMMARY: AgentSessionStatusSummary = {
  sessionId: 'session-1',
  workspaceId: SCOPE.workspaceId,
  agent: 'claude',
  status: 'attention',
  latestPrompt: 'Ship it',
  lastAssistantMessage: 'May I run the migration?',
  updatedAt: 1
}

function settings(overrides: Partial<NotificationSettings> = {}): NotificationSettings {
  return {
    enabled: true,
    agentTaskComplete: true,
    terminalBell: true,
    suppressWhenFocused: false,
    customSoundId: 'system',
    customSoundPath: null,
    customSoundVolume: 1,
    mutedNotificationSourceIds: [],
    ...overrides
  }
}

function harness(overrides: Partial<StructuredAttentionMobileDeliveryDeps> = {}) {
  const sent: MobileNotificationDispatchEvent[] = []
  const reconciled: StructuredAttentionState[] = []
  const delivery = createStructuredAttentionMobileDelivery({
    readNotificationSettings: () => settings(),
    readWorkspaceLabels: () => ({ repoLabel: 'orca', worktreeLabel: 'feature' }),
    dispatch: (event) => sent.push(event),
    reconcile: (state) => reconciled.push(state),
    now: () => 42,
    ...overrides
  })
  return { delivery, sent, reconciled }
}

describe('structured attention mobile delivery', () => {
  it('pushes a raised prompt at once as "needs input", keyed by the prompt', () => {
    const h = harness()
    h.delivery.deliver(PROMPT, SUMMARY)
    const key = agentSessionAttentionKey(PROMPT)
    expect(h.sent).toEqual([
      {
        type: 'notification',
        emittedAt: 42,
        source: 'agent-task-complete',
        title: 'orca / feature - Claude needs input',
        body: 'May I run the migration?',
        worktreeId: SCOPE.workspaceId,
        notificationId: key,
        attentionKey: key,
        agentState: 'blocked'
      }
    ])
  })

  it('words a settled turn by its outcome, and a failure as a failure even while a prompt waits', () => {
    const h = harness()
    h.delivery.deliver(completion('success'), SUMMARY)
    h.delivery.deliver(completion('success', true), SUMMARY)
    h.delivery.deliver(completion('failure', true), SUMMARY)
    expect(h.sent.map((event) => [event.agentState, event.title])).toEqual([
      ['done', 'orca / feature - Claude finished'],
      ['blocked', 'orca / feature - Claude needs input'],
      ['done', 'orca / feature - Claude failed']
    ])
  })

  it('still sends when labels cannot be read, worded generically', () => {
    const h = harness({
      readWorkspaceLabels: () => {
        throw new Error('store not ready')
      }
    })
    h.delivery.deliver(PROMPT, undefined)
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]?.title).toContain('needs input')
  })

  it('marks the push ineligible when agent notifications are off, as the desktop fan-out does', () => {
    const h = harness({
      readNotificationSettings: () => settings({ agentTaskComplete: false })
    })
    h.delivery.deliver(PROMPT, SUMMARY)
    expect(h.sent[0]).toMatchObject({ desktopAllowed: false })
  })

  it('announces nothing for a completion with no verdict', () => {
    const h = harness()
    const edge = completion('success')
    if (edge.type === 'completion') {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: an older host omits a field the wire type requires.
      delete (edge.completion as { outcome?: string }).outcome
    }
    h.delivery.deliver(edge, SUMMARY)
    expect(h.sent).toEqual([])
  })

  it('forwards current prompt state for reconciliation', () => {
    const h = harness()
    const state = { scope: SCOPE, sessionId: 'session-1', pendingPromptIds: ['a', 'b'] }
    h.delivery.reconcile(state)
    expect(h.reconciled).toEqual([state])
  })
})

describe('readStructuredAttentionWorkspaceLabels', () => {
  const store = {
    getRepo: vi.fn((id: string) => (id === 'repo-1' ? { displayName: 'orca' } : undefined)),
    getWorktreeMeta: vi.fn((id: string) =>
      id === SCOPE.workspaceId ? { displayName: 'feature' } : undefined
    ),
    getFolderWorkspaces: vi.fn(() => [{ id: 'folder-1', name: 'Notes' }])
  }

  it('reads a worktree and its repo from persisted metadata', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the read fields are stubbed.
    const labels = readStructuredAttentionWorkspaceLabels(store as never, SCOPE)
    expect(labels).toEqual({ repoLabel: 'orca', worktreeLabel: 'feature' })
  })

  it('reads a folder workspace by its own id', () => {
    const labels = readStructuredAttentionWorkspaceLabels(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the read fields are stubbed.
      store as never,
      { ...SCOPE, workspaceId: 'folder-1', workspaceKind: 'folder' }
    )
    expect(labels).toEqual({ worktreeLabel: 'Notes' })
  })
})
