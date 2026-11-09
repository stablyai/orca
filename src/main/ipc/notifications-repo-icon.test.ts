import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RepoIcon } from '../../shared/repo-icon'
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

const UPLOAD_ICON_SRC =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

async function dispatchFor(worktreeId: string, repoIcon: RepoIcon | null): Promise<void> {
  registerNotificationHandlers(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: dispatch reads only getSettings and getRepo; Store is a class, so a structural double needs the cast.
    {
      getSettings: () => ({
        notifications: {
          enabled: true,
          agentTaskComplete: true,
          terminalBell: false,
          suppressWhenFocused: true
        }
      }),
      getRepo: (id: string) => (id === 'repo' ? { id: 'repo', repoIcon } : undefined)
    } as never
  )
  await getDispatchHandler()(
    {},
    { source: 'agent-task-complete', worktreeId, worktreeLabel: 'feat/icon', repoLabel: 'orca' }
  )
}

describe('notification repo icon', () => {
  beforeEach(() => {
    resetNotificationDispatchMocks()
  })

  it('shows an uploaded project image as the notification icon', async () => {
    await dispatchFor('repo::/src/orca', {
      type: 'image',
      src: UPLOAD_ICON_SRC,
      source: 'upload'
    })

    expect(notificationCtorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Task complete in feat/icon',
        icon: expect.objectContaining({ dataUrl: UPLOAD_ICON_SRC })
      })
    )
  })
})
