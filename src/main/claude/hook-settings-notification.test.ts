import { describe, expect, it } from 'vitest'
import { applyManagedHooks } from './hook-settings'

describe('Claude managed idle notification hook', () => {
  it('installs only the provider idle_prompt notification matcher', () => {
    const config = applyManagedHooks(
      { hooks: {} },
      { type: 'command', command: '/home/ada/.orca/agent-hooks/claude-hook.sh' }
    )

    expect(config.hooks?.Notification).toEqual([
      {
        matcher: 'idle_prompt',
        hooks: [{ type: 'command', command: '/home/ada/.orca/agent-hooks/claude-hook.sh' }]
      }
    ])
  })

  it('preserves user-owned notification hooks', () => {
    const userHook = {
      matcher: 'permission_prompt',
      hooks: [{ type: 'command' as const, command: 'notify-user' }]
    }
    const config = applyManagedHooks(
      { hooks: { Notification: [userHook] } },
      { type: 'command', command: '/home/ada/.orca/agent-hooks/claude-hook.sh' }
    )

    expect(config.hooks?.Notification?.[0]).toEqual(userHook)
    expect(config.hooks?.Notification?.[1]?.matcher).toBe('idle_prompt')
  })
})
