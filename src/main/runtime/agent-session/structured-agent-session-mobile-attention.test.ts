import { describe, expect, it, vi } from 'vitest'
import type {
  AgentSessionAttentionEdge,
  StructuredAttentionState
} from '../../../shared/agent-session/view/agent-session-attention'
import type { AgentSessionFailureFact } from '../../../shared/agent-session/failures/agent-session-failure'
import { formatUsageLimitResetClock } from '../../../shared/agent-session/failures/agent-session-usage-limit'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session/agent-session-wire'
import type { NotificationSettings } from '../../../shared/notifications/notification-settings-types'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../shared/agent-session/view/structured-agent-session-projection'

import {
  createStructuredAttentionMobileDelivery,
  isStructuredAttentionMuted,
  type StructuredAttentionMobileDeliveryDeps
} from './lifecycle/structured-agent-session-mobile-attention'

import type { MobileNotificationDispatchEvent } from '../push/notifications/runtime-mobile-notification-controller'
import { makeTestBot } from '../../bots/bot.test-fixture'
import { botGroupIdOfRoomPaneKey } from '../../../shared/bots/bot-group-room-pane-key'

const SCOPE = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'repo-1::/work/feature',
  workspaceKind: 'git-worktree'
} as const

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
    agentNeedsInput: true,
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
    isMuted: () => false,
    readOrchestration: () => undefined,
    dispatch: (event) => sent.push(event),
    reconcile: (state) => reconciled.push(state),
    now: () => 42,
    ...overrides
  })
  return { delivery, sent, reconciled }
}

describe('structured attention mobile delivery', () => {
  it('says why a failed turn failed, from its typed reason, instead of the last message', () => {
    // Reset and clock both in the local zone, so the words don't depend on the runner's clock or zone.
    const resetsAt = new Date(2026, 9, 28, 18, 39).getTime()
    const failedWith = (failure: AgentSessionFailureFact): AgentSessionAttentionEdge => {
      const failed = completion('failure')
      return failed.type === 'completion'
        ? { ...failed, completion: { ...failed.completion, failure } }
        : failed
    }
    const limit: AgentSessionFailureFact = {
      kind: 'usageLimitReached',
      usageLimit: { window: 'weekly', resetsAt }
    }
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const h = harness()
      const now = new Date(2026, 9, 28, 18, 18).getTime()
      vi.setSystemTime(now)
      h.delivery.deliver(failedWith(limit), SUMMARY)
      h.delivery.deliver(failedWith({ kind: 'notSignedIn' }), SUMMARY)
      // A reset on another day says which day.
      const otherDay = new Date(2026, 9, 29, 9, 0).getTime()
      vi.setSystemTime(otherDay)
      h.delivery.deliver(failedWith(limit), SUMMARY)
      // The reader formats in its own locale; ask the same formatter, so the words match anywhere.
      const resetsAtToday = formatUsageLimitResetClock(resetsAt, now)
      const resetsAtOtherDay = formatUsageLimitResetClock(resetsAt, otherDay)
      expect(h.sent.map((event) => [event.title, event.body])).toEqual([
        [
          'orca / feature - Claude failed',
          `Claude hit its weekly limit. It resets at ${resetsAtToday}.`
        ],
        [
          'orca / feature - Claude failed',
          "Claude isn't signed in. Run `claude auth login`, or choose an account in Claude Accounts settings."
        ],
        [
          'orca / feature - Claude failed',
          `Claude hit its weekly limit. It resets at ${resetsAtOtherDay}.`
        ]
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it("opens a group member's approval in its group room on the phone", () => {
    const h = harness({
      readBotGroupRoom: (sessionId) =>
        sessionId === 'bot-group-member-1'
          ? { group: { id: 'group-1', folderWorkspaceId: 'group-home-1' }, threadId: undefined }
          : null
    })

    h.delivery.deliver(
      {
        type: 'prompt',
        prompt: {
          scope: { ...SCOPE, workspaceId: 'folder:bot-home', workspaceKind: 'folder' },
          sessionId: 'bot-group-member-1',
          promptId: 'approval-1',
          raisedAt: 1
        }
      },
      undefined
    )

    expect(h.sent[0]?.worktreeId).toBe('folder:group-home-1')
    // The phone opens the room its pane key names.
    expect(botGroupIdOfRoomPaneKey(h.sent[0]?.paneKey)).toBe('group-1')
  })
})

describe("a bot run that couldn't finish", () => {
  const botHome = {
    executionHostId: 'local',
    wslDistro: null,
    workspaceId: 'folder:fw-atlas',
    workspaceKind: 'folder'
  } as const
  // A bot run is a turn in the bot's home; its failure is the same edge any chat raises.
  const failedRun: AgentSessionAttentionEdge = {
    type: 'completion',
    completion: {
      scope: botHome,
      sessionId: 'run-session',
      turnId: 'turn-1',
      outcome: 'failure',
      completedAt: 1
    }
  }

  function botHarness(couldNotFinish: boolean) {
    const bot = makeTestBot({
      folderWorkspaceId: 'fw-atlas',
      notifications: { needsPermission: true, taskComplete: true, couldNotFinish }
    })
    return harness({
      readWorkspaceLabels: () => ({ worktreeLabel: 'Atlas' }),
      isMuted: (scope, news) =>
        isStructuredAttentionMuted(
          { isWorkspaceMuted: () => false, bots: () => [bot] },
          scope,
          news
        )
    })
  }

  it('pushes to phones with the fields the gateway takes, opening the run on tap', () => {
    const h = botHarness(true)

    h.delivery.deliver(failedRun, undefined)

    expect(h.sent).toEqual([
      expect.objectContaining({
        source: 'agent-task-complete',
        agentState: 'done',
        worktreeId: 'folder:fw-atlas',
        paneKey: structuredAgentSessionPaneKey(
          structuredAgentSessionTabId('run-session'),
          'run-session'
        )
      })
    ])
  })

  it("stays quiet when the bot's couldn't-finish switch is off", () => {
    const h = botHarness(false)

    h.delivery.deliver(failedRun, undefined)

    expect(h.sent).toEqual([])
  })
})
