import { expect, it, vi } from 'vitest'
import { leaveClaudePlanModeOnApproval } from './claude-plan-approval-mode'

function approve(
  session: {
    launchIntent?: { permissionMode?: string }
    firstRootInit?: { permissionMode: string }
  },
  setPermissionMode = vi.fn(async () => {})
) {
  leaveClaudePlanModeOnApproval(
    {
      ...session,
      reportedOptions: { reportedPermissionMode: 'plan' },
      orderedPermissionMode: null,
      connection: { setPermissionMode }
    },
    { toolName: 'ExitPlanMode' },
    { behavior: 'allow', updatedInput: {} }
  )
  return setPermissionMode
}

it('leaves the restore to Claude when the chat opened in Plan with no launched mode', () => {
  const set = approve({ launchIntent: {}, firstRootInit: { permissionMode: 'plan' } })
  expect(set).not.toHaveBeenCalled()
})
