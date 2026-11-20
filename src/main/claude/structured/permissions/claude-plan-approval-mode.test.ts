import { expect, it, vi } from 'vitest'
import type { PermissionMode, PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import type { ClaudeSession } from '../claude-structured-session-state'
import { claudeStructuredPermissionOptions } from '../launch/claude-structured-launch-resolution'
import { leaveClaudePlanModeOnApproval } from './claude-plan-approval-mode'

function approvePlan(
  session: {
    launchIntent?: ClaudeSession['launchIntent']
    firstRootInit?: ClaudeSession['firstRootInit']
    reported?: string | null
    ordered?: () => string | null | undefined
    applied?: readonly (readonly [string, string])[]
  },
  reply: PermissionResult = {
    behavior: 'allow',
    updatedInput: { plan: 'Ship the fix' },
    toolUseID: 'tool-plan'
  }
) {
  const setPermissionMode = vi.fn(async (_mode: PermissionMode) => {})
  leaveClaudePlanModeOnApproval(
    {
      launchIntent: session.launchIntent,
      firstRootInit: session.firstRootInit,
      reportedOptions: { reportedPermissionMode: session.reported },
      orderedPermissionMode: session.ordered ?? null,
      appliedInputOptions: new Map(session.applied),
      connection: { setPermissionMode }
    },
    { toolName: 'ExitPlanMode' },
    reply
  )
  return { setPermissionMode, reply }
}

function expectBuildMode(result: ReturnType<typeof approvePlan>, mode: PermissionMode): void {
  expect(result.setPermissionMode).toHaveBeenCalledWith(mode)
  expect(result.reply).toMatchObject({
    behavior: 'allow',
    updatedPermissions: [{ type: 'setMode', mode, destination: 'session' }]
  })
}

it('restores Approve for me after a plan-started chat approves ExitPlanMode', () => {
  const result = approvePlan({
    launchIntent: { permissionMode: 'auto' },
    firstRootInit: { permissionMode: 'plan' },
    // The opening setPermissionMode('plan') lands before init's report does.
    reported: 'auto',
    applied: [['interactionMode', 'plan']]
  })
  expectBuildMode(result, 'auto')
})

it('restores Full access after a plan-started chat approves ExitPlanMode', () => {
  expect(claudeStructuredPermissionOptions('full-access')).toMatchObject({
    allowDangerouslySkipPermissions: true,
    extraArgs: { 'dangerously-skip-permissions': null }
  })
  const result = approvePlan({
    launchIntent: { permissionMode: 'bypassPermissions' },
    firstRootInit: { permissionMode: 'plan' },
    reported: 'full-access',
    ordered: () => 'plan',
    applied: [['interactionMode', 'plan']]
  })
  expectBuildMode(result, 'bypassPermissions')
})

it('keeps Ask on the post-plan mode when that is the chat permission', () => {
  const result = approvePlan({
    launchIntent: { permissionMode: 'default' },
    firstRootInit: { permissionMode: 'plan' },
    reported: 'plan',
    applied: [['interactionMode', 'plan']]
  })
  expectBuildMode(result, 'default')
})

it('leaves a chat that is not in plan on its current permission mode', () => {
  const result = approvePlan({
    launchIntent: { permissionMode: 'acceptEdits' },
    firstRootInit: { permissionMode: 'acceptEdits' },
    reported: 'accept-edits',
    applied: [['interactionMode', 'default']]
  })
  expect(result.setPermissionMode).not.toHaveBeenCalled()
  expect(result.reply).not.toHaveProperty('updatedPermissions')

  const kept = approvePlan(
    {
      launchIntent: { permissionMode: 'acceptEdits' },
      firstRootInit: { permissionMode: 'acceptEdits' },
      reported: 'plan',
      applied: [['interactionMode', 'plan']]
    },
    { behavior: 'deny', message: 'Keep planning', toolUseID: 'tool-plan' }
  )
  expect(kept.setPermissionMode).not.toHaveBeenCalled()
})

it('restores Accept edits for a chat that entered plan after launch', () => {
  const result = approvePlan({
    launchIntent: { permissionMode: 'acceptEdits' },
    firstRootInit: { permissionMode: 'acceptEdits' },
    reported: 'plan',
    applied: [['interactionMode', 'plan']]
  })
  expectBuildMode(result, 'acceptEdits')
})
