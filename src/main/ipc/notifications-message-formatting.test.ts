import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  getDispatchHandler,
  notificationCtorMock,
  resetNotificationDispatchMocks
} from './notifications-test-harness'

vi.mock('electron', async () =>
  (await import('./notifications-test-harness')).createElectronModuleMock()
)

vi.mock('./notification-authorization-status', async () =>
  (await import('./notifications-test-harness')).createNotificationAuthorizationModuleMock()
)

vi.mock('./ui', async () =>
  (await import('./notifications-test-harness')).createTrustedUIRendererModuleMock()
)

vi.mock('../tray/system-tray', async () =>
  (await import('./notifications-test-harness')).createSystemTrayModuleMock()
)

import { registerNotificationHandlers } from './notifications'

describe('registerNotificationHandlers', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-28T16:00:00Z'))
    resetNotificationDispatchMocks()
  })

  it('keeps a readable body when no assistant response was captured', async () => {
    registerNotificationHandlers({
      getSettings: () => ({
        notifications: {
          enabled: true,
          agentTaskComplete: true,
          terminalBell: false,
          suppressWhenFocused: true
        }
      })
    } as never)

    const handler = getDispatchHandler()
    expect(
      await handler(
        {},
        {
          source: 'agent-task-complete',
          worktreeId: 'repo::wt1',
          worktreeLabel: 'main',
          repoLabel: 'jinjing-work',
          hasMultipleActiveRepos: true,
          agentType: 'claude',
          agentState: 'done',
          agentPrompt: 'Do not show this request text'
        }
      )
    ).toEqual({ delivered: true })

    expect(notificationCtorMock).toHaveBeenCalledWith({
      title: 'jinjing-work / main - Claude finished',
      body: 'Claude finished.'
    })
  })

  it('formats blocked and interrupted agent snapshots distinctly', async () => {
    registerNotificationHandlers({
      getSettings: () => ({
        notifications: {
          enabled: true,
          agentTaskComplete: true,
          terminalBell: false,
          suppressWhenFocused: false
        }
      })
    } as never)

    const handler = getDispatchHandler()
    expect(
      await handler(
        {},
        {
          source: 'agent-task-complete',
          worktreeId: 'repo::wt1',
          worktreeLabel: 'feat/notis',
          agentType: 'claude',
          agentState: 'blocked',
          agentLastAssistantMessage: 'Please approve the command.'
        }
      )
    ).toEqual({ delivered: true })
    vi.advanceTimersByTime(5001)
    expect(
      await handler(
        {},
        {
          source: 'agent-task-complete',
          worktreeId: 'repo::wt1',
          worktreeLabel: 'feat/notis',
          agentType: 'claude',
          agentState: 'done',
          agentTurnOutcome: 'cancellation',
          agentLastAssistantMessage: 'Stopped by user.'
        }
      )
    ).toEqual({ delivered: true })

    expect(notificationCtorMock).toHaveBeenNthCalledWith(1, {
      title: 'feat/notis - Claude needs input',
      body: 'Please approve the command.'
    })
    expect(notificationCtorMock).toHaveBeenNthCalledWith(2, {
      title: 'feat/notis - Claude stopped',
      body: 'Stopped by user.'
    })
  })

  it('normalizes custom agent labels and re-bounds multiline assistant previews', async () => {
    registerNotificationHandlers({
      getSettings: () => ({
        notifications: {
          enabled: true,
          agentTaskComplete: true,
          terminalBell: false,
          suppressWhenFocused: false
        }
      })
    } as never)

    const longAssistantMessage = `Line one\n\n${'x'.repeat(400)}`
    const handler = getDispatchHandler()
    expect(
      await handler(
        {},
        {
          source: 'agent-task-complete',
          worktreeId: 'repo::wt1',
          worktreeLabel: 'feat/notis',
          agentType: 'builder\nagent',
          agentState: 'done',
          agentLastAssistantMessage: longAssistantMessage
        }
      )
    ).toEqual({ delivered: true })

    const options = (
      notificationCtorMock.mock.calls as unknown as [{ title: string; body: string }][]
    )[0]?.[0]
    if (!options) {
      throw new Error('Expected notification options')
    }
    expect(options).toMatchObject({
      title: 'feat/notis - builder agent finished'
    })
    expect(options.body).toMatch(/^Line one x+/)
    expect(options.body).not.toContain('\n')
    expect(options.body.length).toBeLessThanOrEqual(180)
  })
})
