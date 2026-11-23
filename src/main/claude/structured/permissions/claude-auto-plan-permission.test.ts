import { setImmediate } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { ClaudeControlRequestTimeoutError } from '../../sdk-transport/claude-agent-sdk-control-requests'
import { applyClaudeMessageOptions } from '../launch/claude-structured-message-options'
import {
  finishPermissionCatchUp,
  openPermissionTestSession,
  permissionTestSession,
  refuseClaudePermission
} from './__tests__/claude-permission.test-fixture'
import { claudeInPlan } from './claude-full-access-refusal'
import { leaveClaudePlanModeOnApproval } from './claude-plan-approval-mode'

const startupWarning =
  "Claude didn't start this chat in Approve for me, so Claude uses Ask for approval instead."

it('writes Ask on the next Build send after an Accept edits root init', async () => {
  const askStarted = Promise.withResolvers<void>()
  const askAcknowledged = Promise.withResolvers<void>()
  const { session, rows, writes, frame } = permissionTestSession('auto', () => {
    askStarted.resolve()
    return askAcknowledged.promise
  })
  await openPermissionTestSession(session, 'auto')
  await session.startupSettings
  finishPermissionCatchUp(session)

  frame('init', 'acceptEdits')
  expect(writes).toEqual([])
  expect(rows).toEqual([])
  expect(session.appliedInputOptions.get('buildPermissionMode')).toBeUndefined()

  const build = applyClaudeMessageOptions(session, { interactionMode: 'default' }, undefined)
  await Promise.race([askStarted.promise, build])
  expect(writes).toEqual(['default'])
  expect(rows).toEqual([])
  expect(session.appliedInputOptions.get('buildPermissionMode')).toBeUndefined()

  askAcknowledged.resolve()
  await build
  expect(session.appliedInputOptions.get('buildPermissionMode')).toBe('default')
  expect(rows).toEqual([startupWarning])
  frame('status', 'default')
  expect(rows).toEqual([startupWarning])
})

it('keeps an applied Plan after a timeout until the user approves an exit', async () => {
  const planAcknowledged = Promise.withResolvers<void>()
  const askAcknowledged = Promise.withResolvers<void>()
  const { session, rows, writes, frame } = permissionTestSession('auto', (mode) =>
    mode === 'plan' ? planAcknowledged.promise : askAcknowledged.promise
  )
  await openPermissionTestSession(session, 'auto')
  await session.startupSettings
  finishPermissionCatchUp(session)

  const plan = applyClaudeMessageOptions(session, { interactionMode: 'plan' }, undefined)
  frame('init', 'acceptEdits')
  expect(writes).toEqual(['plan'])

  planAcknowledged.reject(new ClaudeControlRequestTimeoutError('set_permission_mode'))
  await expect(plan).rejects.toBeInstanceOf(ClaudeControlRequestTimeoutError)
  await setImmediate()
  expect(writes).toEqual(['plan'])
  expect(rows).toEqual([])
  expect(session.appliedInputOptions.get('buildPermissionMode')).toBeUndefined()

  frame('status', 'plan')
  leaveClaudePlanModeOnApproval(session, { toolName: 'ExitPlanMode' }, { behavior: 'allow' })
  expect(writes).toEqual(['plan', 'default'])
  expect(rows).toEqual([])

  askAcknowledged.resolve()
  await setImmediate()
  expect(session.appliedInputOptions.get('buildPermissionMode')).toBe('default')
  expect(rows).toEqual([startupWarning])
})

it('warns from the saved root Ask when Plan is rejected without writing Ask', async () => {
  const planAcknowledged = Promise.withResolvers<void>()
  const { session, rows, writes, frame } = permissionTestSession(
    'auto',
    () => planAcknowledged.promise
  )
  await openPermissionTestSession(session, 'auto')
  await session.startupSettings
  finishPermissionCatchUp(session)

  const plan = applyClaudeMessageOptions(session, { interactionMode: 'plan' }, undefined)
  frame('init', 'default')
  expect(writes).toEqual(['plan'])
  expect(rows).toEqual([])

  planAcknowledged.reject(new Error('Claude refused Plan'))
  await expect(plan).rejects.toThrow('Claude refused Plan')
  expect(rows).toEqual([startupWarning])
  expect(writes).toEqual(['plan'])
  expect(session.appliedInputOptions.get('buildPermissionMode')).toBe('default')
  expect(session.acknowledgedBuildPermissionMode).toBeUndefined()
})

it('records a root Ask and posts one startup warning without a write', async () => {
  const { session, rows, writes, frame } = permissionTestSession('auto')
  await openPermissionTestSession(session, 'auto')
  await session.startupSettings
  finishPermissionCatchUp(session)

  frame('init', 'default')
  expect(session.appliedInputOptions.get('buildPermissionMode')).toBe('default')
  expect(session.acknowledgedBuildPermissionMode).toBeUndefined()
  expect(rows).toEqual([startupWarning])
  frame('status', 'default')
  expect(rows).toEqual([startupWarning])
  expect(writes).toEqual([])
})

it('writes Ask on an explicit Build send after Claude reports a fresh Plan', async () => {
  const { session, writes, frame } = permissionTestSession('auto', (mode) =>
    mode === 'auto' ? refuseClaudePermission('auto_mode_model') : Promise.resolve()
  )
  frame('init', 'auto')
  finishPermissionCatchUp(session)
  await applyClaudeMessageOptions(session, { interactionMode: 'default' }, undefined)
  expect(writes).toEqual(['auto', 'default'])

  frame('status', 'default')
  frame('status', 'plan')
  await applyClaudeMessageOptions(session, { interactionMode: 'default' }, undefined)
  expect(writes).toEqual(['auto', 'default', 'default'])
  expect(claudeInPlan(session)).toBe(false)

  frame('status', 'plan')
  expect(claudeInPlan(session)).toBe(true)
})
