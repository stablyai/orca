import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () =>
  (await import('./createMainWindow-test-harness')).electronModuleMock()
)
vi.mock('@electron-toolkit/utils', async () =>
  (await import('./createMainWindow-test-harness')).electronToolkitUtilsMock()
)
vi.mock('./macos-tahoe-release', async () =>
  (await import('./createMainWindow-test-harness')).macosTahoeReleaseMock()
)
vi.mock('../app-icon', async () => (await import('./createMainWindow-test-harness')).appIconMock())
vi.mock('../browser/browser-manager', async () =>
  (await import('./createMainWindow-test-harness')).browserManagerMock()
)

import { createMainWindow } from './createMainWindow'
import {
  createRendererRecoveryWindowHarness,
  resetMainWindowMocks
} from './createMainWindow-test-harness'

describe('createMainWindow swipe navigation', () => {
  beforeEach(() => {
    resetMainWindowMocks()
  })

  it('forwards horizontal swipes to the window as back/forward and ignores vertical ones', () => {
    const { windowHandlers, send } = createRendererRecoveryWindowHarness()
    createMainWindow(null)
    send.mockClear()

    for (const direction of ['left', 'right', 'up', 'down']) {
      windowHandlers.swipe({}, direction)
    }

    expect(send.mock.calls).toEqual([
      ['ui:swipeNavigate', 'back'],
      ['ui:swipeNavigate', 'forward']
    ])
  })
})
