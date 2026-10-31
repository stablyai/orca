import { describe, expect, it, vi } from 'vitest'
import type {
  AgentSessionAttentionEdge,
  StructuredAttentionState
} from '../../shared/agent-session-attention'

import type { AgentSessionStatusSummary } from '../../shared/agent-session-wire'
import type { NotificationSettings } from '../../shared/notification-settings-types'

import {
  createStructuredAttentionMobileDelivery,
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
    notifyHiddenWorkspaces: true,
    ...overrides
  }
}

function harness(overrides: Partial<StructuredAttentionMobileDeliveryDeps> = {}) {
  const sent: MobileNotificationDispatchEvent[] = []
  const reconciled: StructuredAttentionState[] = []
  const delivery = createStructuredAttentionMobileDelivery({
    readNotificationSettings: () => settings(),
    readWorkspaceLabels: () => ({ repoLabel: 'orca', worktreeLabel: 'feature' }),
    isWorkspaceMuted: () => false,
    dispatch: (event) => sent.push(event),
    reconcile: (state) => reconciled.push(state),
    now: () => 42,
    ...overrides
  })
  return { delivery, sent, reconciled }
}

describe('structured attention mobile delivery', () => {
  it('sends nothing for a workspace whose notifications are muted', () => {
    const isWorkspaceMuted = vi.fn(() => true)
    const quiet = harness({ isWorkspaceMuted })
    quiet.delivery.deliver(PROMPT, SUMMARY)
    quiet.delivery.deliver(completion('success'), SUMMARY)
    expect(quiet.sent).toEqual([])
    expect(isWorkspaceMuted).toHaveBeenCalledWith(SCOPE)
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
})
