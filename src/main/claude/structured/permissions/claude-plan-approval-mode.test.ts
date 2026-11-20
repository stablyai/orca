import { describe, expect, it, vi } from 'vitest'
import { leaveClaudePlanModeOnApproval } from './claude-plan-approval-mode'

function approvePlan(
  launched: 'bypassPermissions' | 'acceptEdits',
  opened: string,
  bypassDisabled?: boolean
): string | undefined {
  const setPermissionMode = vi.fn((_mode: string) => Promise.resolve())
  leaveClaudePlanModeOnApproval(
    {
      launchIntent: { permissionMode: launched },
      firstRootInit: { permissionMode: opened },
      ...(bypassDisabled === undefined ? {} : { bypassDisabled }),
      reportedOptions: { reportedPermissionMode: 'plan' },
      connection: { setPermissionMode }
    },
    { toolName: 'ExitPlanMode' },
    { behavior: 'allow', updatedInput: {} }
  )
  return setPermissionMode.mock.calls[0]?.[0]
}

describe('leaving Plan mode after an approved plan', () => {
  it('builds in the mode Claude opened when its settings refused Full access', () => {
    expect(approvePlan('bypassPermissions', 'default')).toBe('default')
  })

  it('builds in Ask when a Plan start hid the refusal but Claude reports bypass turned off', () => {
    expect(approvePlan('bypassPermissions', 'plan', true)).toBe('default')
  })

  it('restores Full access where Claude allows it', () => {
    expect(approvePlan('bypassPermissions', 'bypassPermissions')).toBe('bypassPermissions')
    expect(approvePlan('bypassPermissions', 'plan', false)).toBe('bypassPermissions')
  })

  it('restores the requested mode over a start that was not a Full access refusal', () => {
    expect(approvePlan('acceptEdits', 'default')).toBe('acceptEdits')
  })
})
