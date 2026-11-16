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
})
