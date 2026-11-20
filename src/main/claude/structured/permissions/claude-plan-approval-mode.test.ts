import { describe, expect, it, vi } from 'vitest'
import { leaveClaudePlanModeOnApproval } from './claude-plan-approval-mode'
import { setClaudeAllowedPermissionMode } from './claude-full-access-refusal'

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

  it('ends in Ask when Claude refuses bypass and no settings read said so', async () => {
    const setPermissionMode = vi.fn((mode: string) =>
      mode === 'bypassPermissions'
        ? Promise.reject(
            new Error(
              'Cannot set permission mode to bypassPermissions because it is disabled by settings or configuration'
            )
          )
        : Promise.resolve()
    )
    const appliedInputOptions = new Map<string, string>()
    leaveClaudePlanModeOnApproval(
      {
        launchIntent: { permissionMode: 'bypassPermissions' },
        firstRootInit: { permissionMode: 'plan' },
        reportedOptions: { reportedPermissionMode: 'plan' },
        appliedInputOptions,
        connection: { setPermissionMode }
      },
      { toolName: 'ExitPlanMode' },
      { behavior: 'allow', updatedInput: {} }
    )
    await vi.waitFor(() => expect(appliedInputOptions.get('buildPermissionMode')).toBe('default'))
    expect(setPermissionMode.mock.calls.map(([mode]) => mode)).toEqual([
      'default',
      'bypassPermissions'
    ])
  })

  it('restores Full access where Claude allows it', () => {
    expect(approvePlan('bypassPermissions', 'bypassPermissions')).toBe('bypassPermissions')
    expect(approvePlan('bypassPermissions', 'plan', false)).toBe('bypassPermissions')
  })

  it('restores the requested mode over a start that was not a Full access refusal', () => {
    expect(approvePlan('acceptEdits', 'default')).toBe('acceptEdits')
  })

  it('asks once when Claude accepts bypass after a Plan start no settings read covered', async () => {
    const setPermissionMode = vi.fn((_mode: string) => Promise.resolve())
    const session = {
      launchIntent: { permissionMode: 'bypassPermissions' },
      firstRootInit: { permissionMode: 'plan' },
      connection: { setPermissionMode }
    }
    expect(await setClaudeAllowedPermissionMode(session, 'bypassPermissions')).toBe(
      'bypassPermissions'
    )
    expect(await setClaudeAllowedPermissionMode(session, 'bypassPermissions')).toBe(
      'bypassPermissions'
    )
    expect(setPermissionMode.mock.calls.map(([mode]) => mode)).toEqual([
      'default',
      'bypassPermissions',
      'bypassPermissions'
    ])
  })

  it('falls back when Claude starts refusing bypass it allowed earlier', async () => {
    let refuse = false
    const setPermissionMode = vi.fn((mode: string) =>
      refuse && mode === 'bypassPermissions'
        ? Promise.reject(
            new Error(
              'Cannot set permission mode to bypassPermissions because it is disabled by settings or configuration'
            )
          )
        : Promise.resolve()
    )
    const session = {
      launchIntent: { permissionMode: 'bypassPermissions' },
      firstRootInit: { permissionMode: 'bypassPermissions' },
      connection: { setPermissionMode }
    }
    expect(await setClaudeAllowedPermissionMode(session, 'bypassPermissions')).toBe(
      'bypassPermissions'
    )
    refuse = true
    expect(await setClaudeAllowedPermissionMode(session, 'bypassPermissions')).toBe('default')
    expect(await setClaudeAllowedPermissionMode(session, 'bypassPermissions')).toBe('default')
  })
})
