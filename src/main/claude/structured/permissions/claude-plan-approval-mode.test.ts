import { describe, expect, it, vi } from 'vitest'
import { leaveClaudePlanModeOnApproval } from './claude-plan-approval-mode'

function approvePlan(launched: 'bypassPermissions' | 'acceptEdits', opened: string): string {
  const setPermissionMode = vi.fn(() => Promise.resolve())
  leaveClaudePlanModeOnApproval(
    {
      launchIntent: { permissionMode: launched },
      firstRootInit: { permissionMode: opened },
      reportedOptions: { reportedPermissionMode: 'plan' },
      connection: { setPermissionMode }
    },
    { toolName: 'ExitPlanMode' },
    { behavior: 'allow', updatedInput: {} }
  )
  return setPermissionMode.mock.calls[0]?.[0] as string
}

describe('leaveClaudePlanModeOnApproval', () => {
  it('builds in the mode Claude opened when its settings refused Full access', () => {
    expect(approvePlan('bypassPermissions', 'default')).toBe('default')
  })

  it('restores Full access when Claude opened in it', () => {
    expect(approvePlan('bypassPermissions', 'bypassPermissions')).toBe('bypassPermissions')
  })

  it('restores the requested mode over a start that was not a Full access refusal', () => {
    expect(approvePlan('acceptEdits', 'default')).toBe('acceptEdits')
  })
})
