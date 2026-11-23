import { setImmediate } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { applyClaudeMessageOptions } from '../launch/claude-structured-message-options'
import {
  finishPermissionCatchUp,
  openPermissionTestSession,
  permissionTestSession,
  refuseClaudePermission
} from './__tests__/claude-permission.test-fixture'
import { claudeInPlan } from './claude-full-access-refusal'

it.each(['accepted', 'refused'])(
  'defers startup Ask until a pending Plan write is %s',
  async (result) => {
    const planAcknowledged = Promise.withResolvers<void>()
    const { session, writes, frame } = permissionTestSession('auto', (mode) =>
      mode === 'plan' ? planAcknowledged.promise : Promise.resolve()
    )
    await openPermissionTestSession(session, 'auto')
    await session.startupSettings
    finishPermissionCatchUp(session)

    const plan = applyClaudeMessageOptions(session, { interactionMode: 'plan' }, undefined)
    frame('init', 'acceptEdits')
    expect(writes).toEqual(['plan'])

    if (result === 'accepted') {
      planAcknowledged.resolve()
      await plan
      expect(claudeInPlan(session)).toBe(true)
      expect(writes).toEqual(['plan'])
      await applyClaudeMessageOptions(session, { interactionMode: 'default' }, undefined)
    } else {
      const rejection = new Error('Claude refused Plan')
      planAcknowledged.reject(rejection)
      await expect(plan).rejects.toThrow(rejection.message)
      await setImmediate()
    }
    expect(writes).toEqual(['plan', 'default'])
    expect(claudeInPlan(session)).toBe(false)
  }
)

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
