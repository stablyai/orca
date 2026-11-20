import { describe, expect, it, vi } from 'vitest'
import { leaveClaudePlanModeOnApproval } from './claude-plan-approval-mode'
import { setClaudeAllowedPermissionMode } from './claude-full-access-refusal'

const BYPASS_REFUSAL =
  'Cannot set permission mode to bypassPermissions because it is disabled by settings or configuration'
const AUTO_REFUSAL = 'Cannot set permission mode to auto: auto mode disabled by settings'

/** A Claude that refuses the given modes the way the CLI does. */
function claude(refuses: string[]) {
  return vi.fn((mode: string) =>
    refuses.includes(mode)
      ? Promise.reject(new Error(mode === 'auto' ? AUTO_REFUSAL : BYPASS_REFUSAL))
      : Promise.resolve()
  )
}

async function approvePlan(
  facts: { launched: string; opened: string; bypassDisabled?: boolean; autoDisabled?: boolean },
  refuses: string[] = []
): Promise<{ applied: string | undefined; written: string[] }> {
  const setPermissionMode = claude(refuses)
  const appliedInputOptions = new Map<string, string>()
  leaveClaudePlanModeOnApproval(
    {
      launchIntent: { permissionMode: facts.launched },
      firstRootInit: { permissionMode: facts.opened },
      ...(facts.bypassDisabled === undefined ? {} : { bypassDisabled: facts.bypassDisabled }),
      ...(facts.autoDisabled === undefined ? {} : { autoDisabled: facts.autoDisabled }),
      reportedOptions: { reportedPermissionMode: 'plan' },
      appliedInputOptions,
      connection: { setPermissionMode }
    },
    { toolName: 'ExitPlanMode' },
    { behavior: 'allow', updatedInput: {} }
  )
  await vi.waitFor(() => expect(appliedInputOptions.has('buildPermissionMode')).toBe(true))
  return {
    applied: appliedInputOptions.get('buildPermissionMode'),
    written: setPermissionMode.mock.calls.map(([mode]) => mode)
  }
}

describe('leaving Plan mode after an approved plan', () => {
  it('builds in Approve for me when Claude refused Full access at start', async () => {
    const result = await approvePlan({ launched: 'bypassPermissions', opened: 'default' })
    expect(result).toEqual({ applied: 'auto', written: ['default', 'auto'] })
  })

  it('builds in Ask when Claude turns auto mode off too', async () => {
    expect(
      await approvePlan(
        { launched: 'bypassPermissions', opened: 'plan', bypassDisabled: true, autoDisabled: true },
        ['bypassPermissions', 'auto']
      )
    ).toEqual({ applied: 'default', written: ['default'] })
    expect(
      await approvePlan({ launched: 'bypassPermissions', opened: 'default' }, ['auto'])
    ).toEqual({ applied: 'default', written: ['default', 'auto'] })
  })

  it('ends in the best mode Claude accepts when no settings read said what it allows', async () => {
    expect(
      await approvePlan({ launched: 'bypassPermissions', opened: 'plan' }, ['bypassPermissions'])
    ).toEqual({ applied: 'auto', written: ['default', 'auto', 'bypassPermissions'] })
    expect(await approvePlan({ launched: 'bypassPermissions', opened: 'plan' })).toEqual({
      applied: 'bypassPermissions',
      written: ['default', 'auto', 'bypassPermissions']
    })
  })

  it('restores Full access where Claude allows it', async () => {
    expect(
      await approvePlan({ launched: 'bypassPermissions', opened: 'bypassPermissions' })
    ).toEqual({ applied: 'bypassPermissions', written: ['bypassPermissions'] })
  })

  it('restores the requested mode over a start that was not a Full access refusal', async () => {
    expect(await approvePlan({ launched: 'acceptEdits', opened: 'default' })).toEqual({
      applied: 'acceptEdits',
      written: ['acceptEdits']
    })
  })

  it('asks once when Claude accepts bypass after a Plan start no settings read covered', async () => {
    const setPermissionMode = claude([])
    const session = {
      launchIntent: { permissionMode: 'bypassPermissions' },
      firstRootInit: { permissionMode: 'plan' },
      connection: { setPermissionMode }
    }
    await setClaudeAllowedPermissionMode(session, 'bypassPermissions')
    await setClaudeAllowedPermissionMode(session, 'bypassPermissions')
    expect(setPermissionMode.mock.calls.map(([mode]) => mode)).toEqual([
      'default',
      'auto',
      'bypassPermissions',
      'bypassPermissions'
    ])
  })

  it('falls back when Claude starts refusing bypass it allowed earlier', async () => {
    const refuses: string[] = []
    const setPermissionMode = claude(refuses)
    const session = {
      launchIntent: { permissionMode: 'bypassPermissions' },
      firstRootInit: { permissionMode: 'bypassPermissions' },
      connection: { setPermissionMode }
    }
    expect(await setClaudeAllowedPermissionMode(session, 'bypassPermissions')).toBe(
      'bypassPermissions'
    )
    refuses.push('bypassPermissions')
    expect(await setClaudeAllowedPermissionMode(session, 'bypassPermissions')).toBe('auto')
    expect(await setClaudeAllowedPermissionMode(session, 'bypassPermissions')).toBe('auto')
  })
})
