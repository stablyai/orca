import { describe, expect, it, vi } from 'vitest'
import {
  BROWSER_AUTOMATION_ACTIVITY_CHANNEL,
  type BrowserAutomationActivityEvent
} from '../../shared/browser-automation-activity'

const mocks = vi.hoisted(() => ({ on: vi.fn(), removeListener: vi.fn() }))

vi.mock('electron', () => ({ ipcRenderer: mocks }))

import { browserPageInteractionAndSessionsApi } from './browser-bridge-page-interaction-and-sessions'

describe('browser automation activity preload subscription', () => {
  it('forwards the activity payload and removes only its own listener', () => {
    const callback = vi.fn()
    const unsubscribe = browserPageInteractionAndSessionsApi.onAutomationActivity(callback)
    const [channel, listener] = mocks.on.mock.calls[0]
    const activity: BrowserAutomationActivityEvent = {
      browserPageId: 'page-b',
      token: 'command-a',
      active: true,
      expiresAt: 30_000
    }
    expect(channel).toBe(BROWSER_AUTOMATION_ACTIVITY_CHANNEL)
    listener({}, activity)
    expect(callback).toHaveBeenCalledWith(activity)
    unsubscribe()
    expect(mocks.removeListener).toHaveBeenCalledWith(channel, listener)
  })
})
