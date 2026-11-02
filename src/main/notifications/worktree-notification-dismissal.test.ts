import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  dismissWorktreeNotifications,
  setWorktreeNotificationDismissal
} from './worktree-notification-dismissal'

afterEach(() => {
  setWorktreeNotificationDismissal(null)
})

describe('worktree notification dismissal injection', () => {
  it('routes to the installed implementation', () => {
    const dismissal = vi.fn(() => 3)
    setWorktreeNotificationDismissal(dismissal)
    const runtime = {} as Parameters<typeof dismissWorktreeNotifications>[1]
    expect(dismissWorktreeNotifications('repo::/w', runtime)).toBe(3)
    expect(dismissal).toHaveBeenCalledWith('repo::/w', runtime)
  })

  it('is a no-op until the Electron process installs one', () => {
    expect(dismissWorktreeNotifications('repo::/w')).toBe(0)
  })
})
