import { setImmediate } from 'node:timers/promises'
import { expect, it, vi } from 'vitest'
import { ClaudeControlRequestTimeoutError } from '../../sdk-transport/claude-agent-sdk-control-requests'
import { applyClaudeMessageOptions } from '../launch/claude-structured-message-options'
import { claudeModelTransitionRestart } from '../launch/claude-structured-options'
import {
  finishPermissionCatchUp,
  openPermissionTestSession,
  permissionTestSession,
  refuseClaudePermission
} from './__tests__/claude-permission.test-fixture'
import { claimClaudePermissionModeRequest } from './claude-permission-mode-ladder'
import { leaveClaudePlanModeOnApproval } from './claude-plan-approval-mode'

const settingsOff = { effective: { disableAutoMode: 'disable' } }
const settingsWarning =
  "Claude's settings turn off Approve for me (disableAutoMode), so Claude uses Ask for approval instead."
const startupWarning =
  "Claude didn't start this chat in Approve for me, so Claude uses Ask for approval instead."
const temporaryWarning =
  "Approve for me isn't available right now, so Claude uses Ask for approval instead."

it.each(['auto_mode_model', 'auto_mode_fast_mode', 'auto_mode_circuit_breaker'])(
  'keeps Ask for the process after Claude replies %s',
  async (code) => {
    let autoAttempts = 0
    const { session, rows, writes, frame } = permissionTestSession('auto', async (mode) => {
      if (mode === 'auto' && ++autoAttempts === 1) {
        await refuseClaudePermission(code)
      }
    })
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    try {
      frame('init', 'auto')
      finishPermissionCatchUp(session)
      await applyClaudeMessageOptions(session, { interactionMode: 'default' }, undefined)
      expect(writes).toEqual(['auto', 'default'])
      expect(rows).toEqual([temporaryWarning])

      await applyClaudeMessageOptions(session, { interactionMode: 'default' }, undefined)
      await applyClaudeMessageOptions(session, {}, undefined)
      await applyClaudeMessageOptions(session, { model: 'next-model', fastMode: 'true' }, undefined)
      clock.mockReturnValue(121_000)
      await applyClaudeMessageOptions(session, {}, undefined)
      expect(writes).toEqual(['auto', 'default'])
      expect(rows).toEqual([temporaryWarning])

      await applyClaudeMessageOptions(session, { interactionMode: 'plan' }, undefined)
      frame('status', 'plan')
      leaveClaudePlanModeOnApproval(session, { toolName: 'ExitPlanMode' }, { behavior: 'allow' })
      await setImmediate()
      await applyClaudeMessageOptions(session, {}, undefined)
      expect(session.appliedInputOptions.get('buildPermissionMode')).toBe('default')
      expect(writes).toEqual(['auto', 'default', 'plan', 'default'])
      expect(rows).toEqual([temporaryWarning])
    } finally {
      clock.mockRestore()
    }
  }
)

it.each([
  { code: 'auto_mode_circuit_breaker', interval: 60_000 },
  { code: 'internal_error', interval: 10_000 }
])('retains the Full access fallback retry after $code', async ({ code, interval }) => {
  let autoAttempts = 0
  const { session, rows, writes, frame } = permissionTestSession(
    'bypassPermissions',
    async (mode) => {
      if (mode === 'auto' && ++autoAttempts === 1) {
        await refuseClaudePermission(code)
      }
    }
  )
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000)
  try {
    await openPermissionTestSession(session, 'bypassPermissions', async () => ({
      effective: { permissions: { disableBypassPermissionsMode: 'disable' } }
    }))
    await session.startupSettings
    finishPermissionCatchUp(session)

    await applyClaudeMessageOptions(session, {}, undefined)
    frame('status', 'default')
    const firstWarning =
      "Claude's settings turn off Full access (permissions.disableBypassPermissionsMode) and Approve for me isn't available right now, so Claude uses Ask for approval instead."
    const initialRows = code === 'internal_error' ? [] : [firstWarning]
    expect(rows).toEqual(initialRows)
    clock.mockReturnValue(1_000 + interval - 1)
    await applyClaudeMessageOptions(session, {}, undefined)
    expect(writes).toEqual(['default', 'auto'])

    clock.mockReturnValue(1_000 + interval)
    await applyClaudeMessageOptions(session, {}, undefined)
    frame('status', 'auto')
    frame('status', 'auto')
    expect(writes).toEqual(['default', 'auto', 'default', 'auto'])
    expect(rows).toEqual([
      ...initialRows,
      "Claude's settings turn off Full access (permissions.disableBypassPermissionsMode), so Claude uses Approve for me instead."
    ])
  } finally {
    clock.mockRestore()
  }
})

it.each(['timeout', 'internal_error'])(
  'retries unanswered Auto after %s and a root Ask',
  async (code) => {
    const askStarted = Promise.withResolvers<void>()
    const askAcknowledged = Promise.withResolvers<void>()
    let autoAttempts = 0
    const { session, rows, writes, frame } = permissionTestSession('auto', async (mode) => {
      if (mode === 'auto' && ++autoAttempts === 1) {
        if (code === 'timeout') {
          throw new ClaudeControlRequestTimeoutError('set_permission_mode')
        }
        return refuseClaudePermission(code)
      }
      if (mode === 'default') {
        askStarted.resolve()
        await askAcknowledged.promise
      }
    })
    await openPermissionTestSession(session, 'auto')
    frame('status', 'plan')
    finishPermissionCatchUp(session)
    const build = applyClaudeMessageOptions(session, { interactionMode: 'default' }, undefined)
    await Promise.race([askStarted.promise, build])
    expect(rows).toEqual([])

    askAcknowledged.resolve()
    await build
    expect(session.appliedInputOptions.has('buildPermissionMode')).toBe(false)
    expect(session.acknowledgedBuildPermissionMode).toBeUndefined()
    frame('init', 'default')
    expect(rows).toEqual([])

    await applyClaudeMessageOptions(session, {}, undefined)
    expect(writes).toEqual(['auto', 'default', 'auto'])
    expect(session.appliedInputOptions.get('buildPermissionMode')).toBe('auto')
    expect(rows).toEqual([])

    const restart = claudeModelTransitionRestart(new Map([['session', session]]))
    expect(
      restart({ sessionId: 'session', fence: 1, executionOptions: { model: 'next-model' } })
    ).toBe(false)
  }
)

it('shows a settings warning only after the Ask acknowledgement leaves Plan', async () => {
  const settings = Promise.withResolvers<unknown>()
  const askStarted = Promise.withResolvers<void>()
  const acknowledged = Promise.withResolvers<void>()
  const { session, rows, writes, frame } = permissionTestSession('auto', async (mode) => {
    if (mode === 'auto') {
      throw new ClaudeControlRequestTimeoutError('set_permission_mode')
    }
    askStarted.resolve()
    await acknowledged.promise
  })
  await openPermissionTestSession(session, 'auto', () => settings.promise)
  frame('status', 'plan')
  finishPermissionCatchUp(session)
  const build = applyClaudeMessageOptions(session, { interactionMode: 'default' }, undefined)
  await Promise.race([askStarted.promise, build])

  settings.resolve(settingsOff)
  await session.startupSettings
  frame('status', 'plan')
  expect(rows).toEqual([])

  acknowledged.resolve()
  await build
  expect(rows).toEqual([settingsWarning])
  frame('init', 'default')
  await applyClaudeMessageOptions(session, {}, undefined)
  expect(writes).toEqual(['auto', 'default'])
  expect(rows).toEqual([settingsWarning])
})

it('uses the root Ask report when an unanswered fallback acknowledgement is superseded', async () => {
  const settings = Promise.withResolvers<unknown>()
  const askStarted = Promise.withResolvers<void>()
  const acknowledged = Promise.withResolvers<void>()
  const { session, rows, frame } = permissionTestSession('auto', async (mode) => {
    if (mode === 'auto') {
      throw new ClaudeControlRequestTimeoutError('set_permission_mode')
    }
    if (mode === 'default') {
      askStarted.resolve()
      await acknowledged.promise
    }
  })
  await openPermissionTestSession(session, 'auto', () => settings.promise)
  frame('status', 'plan')
  finishPermissionCatchUp(session)
  const build = applyClaudeMessageOptions(session, { interactionMode: 'default' }, undefined)
  await Promise.race([askStarted.promise, build])

  settings.resolve(settingsOff)
  await session.startupSettings
  claimClaudePermissionModeRequest(session)
  acknowledged.resolve()
  await build
  expect(rows).toEqual([])
  expect(session.appliedInputOptions.has('buildPermissionMode')).toBe(false)

  frame('init', 'default')
  expect(rows).toEqual([settingsWarning])
})

it.each([
  { early: true, configured: true, warning: settingsWarning },
  { early: false, configured: true, warning: settingsWarning },
  { early: true, configured: false, warning: startupWarning },
  { early: false, configured: false, warning: startupWarning }
])(
  'settles a root Ask with early settings $early and disableAutoMode $configured',
  async (scenario) => {
    const settings = Promise.withResolvers<unknown>()
    const { session, rows, writes, frame } = permissionTestSession('auto')
    await openPermissionTestSession(session, 'auto', () => settings.promise)
    finishPermissionCatchUp(session)

    if (!scenario.early) {
      frame('init', 'default')
      expect(rows).toEqual([])
    }
    settings.resolve(scenario.configured ? settingsOff : { effective: {} })
    await session.startupSettings
    if (scenario.early) {
      frame('init', 'default')
    }
    frame('status', 'default')
    expect(rows).toEqual([scenario.warning])
    expect(writes).toEqual([])
  }
)

it('immediately requests Ask for a genuine root init in Accept edits', async () => {
  const acknowledged = Promise.withResolvers<void>()
  const { session, rows, writes, frame } = permissionTestSession('auto', () => acknowledged.promise)
  await openPermissionTestSession(session, 'auto')
  await session.startupSettings
  finishPermissionCatchUp(session)

  frame('init', 'acceptEdits')
  expect(writes).toEqual(['default'])
  expect(rows).toEqual([])
  acknowledged.resolve()
  await setImmediate()
  expect(rows).toEqual([startupWarning])
})

it('keeps one startup warning when late settings explain the same Ask fallback', async () => {
  const settings = Promise.withResolvers<unknown>()
  const { session, rows, frame } = permissionTestSession('auto')
  await openPermissionTestSession(session, 'auto', () => settings.promise)
  const pending = session.startupSettings
  finishPermissionCatchUp(session)
  frame('init', 'default')

  session.startupSettings = undefined
  frame('status', 'default')
  expect(rows).toEqual([startupWarning])
  settings.resolve(settingsOff)
  await pending
  frame('status', 'default')
  expect(rows).toEqual([startupWarning])
})

it('holds an idle initialize Ask warning through catch-up and a root status frame', async () => {
  const { session, rows, writes, frame } = permissionTestSession('auto')
  await openPermissionTestSession(session, 'default', async () => settingsOff)
  await session.startupSettings
  frame('status')
  expect(rows).toEqual([])

  finishPermissionCatchUp(session)
  frame('status')
  expect(rows).toEqual([settingsWarning])
  expect(writes).toEqual([])
})

it('holds a confirmed startup warning while Plan is active', async () => {
  const { session, rows, writes, frame } = permissionTestSession('auto')
  await openPermissionTestSession(session, 'auto', async () => settingsOff)
  await session.startupSettings
  frame('init', 'default')
  frame('status', 'plan')
  finishPermissionCatchUp(session)
  expect(rows).toEqual([])

  leaveClaudePlanModeOnApproval(session, { toolName: 'ExitPlanMode' }, { behavior: 'allow' })
  await setImmediate()
  expect(writes).toEqual(['default'])
  expect(rows).toEqual([settingsWarning])
})
