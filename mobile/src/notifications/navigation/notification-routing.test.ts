import { describe, expect, it } from 'vitest'
import { parseMobileSessionAccessTarget } from '../../session/mobile-session-item-target'
import { getNotificationNavigationTarget } from './notification-routing'

const home = { hostId: 'host-1', worktreeId: 'folder:bot-home', paneKey: 'agent-session:chat-1' }

describe('an access request push', () => {
  it('opens the bot home with the request to review; other pushes carry none', () => {
    const access = getNotificationNavigationTarget({ ...home, accessRequestId: 'req-1' })
    expect(access?.sessionTarget?.params).toMatchObject({
      worktreeId: 'folder:bot-home',
      paneKey: 'agent-session:chat-1'
    })
    expect(parseMobileSessionAccessTarget(access?.sessionTarget?.params.botItem)).toBe('req-1')

    const agent = getNotificationNavigationTarget(home)
    expect(agent?.sessionTarget?.params.botItem).toBeUndefined()
  })
})
