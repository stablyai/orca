import { describe, expect, it } from 'vitest'
import type { NotificationDispatchRequest } from '../../shared/notification-settings-types'
import { buildNotificationOptions } from './notification-options'

// Shows which key was asked for and with what values, so the test can tell copy apart from code.
function keyTranslator(key: string, _fallback: string, values?: Record<string, string>): string {
  return values ? `${key}(${JSON.stringify(values)})` : key
}

function request(overrides: Partial<NotificationDispatchRequest>): NotificationDispatchRequest {
  return { source: 'agent-task-complete', worktreeId: 'wt-1', ...overrides }
}

describe('buildNotificationOptions localization', () => {
  it('keeps the English copy, placeholders filled, without a translator', () => {
    expect(
      buildNotificationOptions(request({ source: 'terminal-bell', worktreeLabel: 'feature-x' }))
    ).toEqual({ title: 'Bell in feature-x', body: 'Attention requested' })
    expect(buildNotificationOptions(request({ worktreeLabel: 'feature-x' }))).toEqual({
      title: 'Task complete in feature-x',
      body: 'A coding agent finished working.'
    })
    expect(
      buildNotificationOptions(request({ agentType: 'claude', agentToolName: 'Bash' })).body
    ).toBe('Using Bash')
  })

  it('reads every sentence it shows from the translator', () => {
    expect(
      buildNotificationOptions(
        request({ source: 'terminal-bell', repoLabel: 'orca' }),
        keyTranslator
      )
    ).toEqual({
      title: 'notifications.bell.title({"worktree":"notifications.workspaceFallback"})',
      body: 'orca · notifications.bell.attentionRequested'
    })
    expect(buildNotificationOptions(request({ source: 'test' }), keyTranslator)).toEqual({
      title: 'notifications.test.title',
      body: 'notifications.test.body'
    })
    expect(buildNotificationOptions(request({}), keyTranslator)).toEqual({
      title: 'notifications.taskComplete.title({"worktree":"notifications.workspaceFallback"})',
      body: 'notifications.taskComplete.body'
    })
    expect(
      buildNotificationOptions(
        request({ agentType: 'unknown', agentState: 'done', agentToolInput: 'ls' }),
        keyTranslator
      )
    ).toEqual({
      title: 'notifications.workspaceFallback - Agent notifications.agentStatus.finished',
      body: 'notifications.agentTool.input({"input":"ls"})'
    })
  })
})
