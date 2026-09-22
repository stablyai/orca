import { describe, expect, it } from 'vitest'
import { applyManagedHooks } from './hook-settings'

const SCRIPT_FILE_NAME = 'claude-hook.sh'
const MANAGED_COMMAND = '/home/dev/.orca/agent-hooks/claude-hook.sh'
const managedHook = { type: 'command' as const, command: MANAGED_COMMAND }

describe('Claude SessionEnd managed hook capability', () => {
  it('installs SessionEnd beside SessionStart for the measured capable version', () => {
    const written = applyManagedHooks({ hooks: {} }, managedHook, SCRIPT_FILE_NAME, {
      claudeVersion: '2.1.261 (Claude Code)'
    })

    expect(written.hooks?.SessionEnd?.[0]?.hooks?.[0]?.command).toBe(MANAGED_COMMAND)
    expect(written.hooks?.SessionStart?.[0]?.hooks?.[0]?.command).toBe(MANAGED_COMMAND)
  })

  it.each(['2.1.260', 'unknown', undefined])(
    'retains the legacy event set for an incapable or unverified host (%s)',
    (claudeVersion) => {
      const written = applyManagedHooks({ hooks: {} }, managedHook, SCRIPT_FILE_NAME, {
        claudeVersion
      })

      expect(written.hooks?.SessionEnd).toBeUndefined()
      expect(written.hooks?.SessionStart).toBeDefined()
    }
  )

  it('removes only Orca SessionEnd during a capability downgrade', () => {
    const capable = applyManagedHooks(
      {
        hooks: {
          SessionEnd: [{ hooks: [{ type: 'command', command: 'echo user-session-end' }] }]
        }
      },
      managedHook,
      SCRIPT_FILE_NAME,
      { claudeVersion: '2.1.261' }
    )
    const downgraded = applyManagedHooks(capable, managedHook, SCRIPT_FILE_NAME, {
      claudeVersion: '2.1.260'
    })

    expect(downgraded.hooks?.SessionEnd).toEqual([
      { hooks: [{ type: 'command', command: 'echo user-session-end' }] }
    ])
  })
})
