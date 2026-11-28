import { setImmediate } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { ClaudeControlRequestTimeoutError } from '../../sdk-transport/claude-agent-sdk-control-requests'
import { applyClaudeMessageOptions } from '../launch/claude-structured-message-options'
import { claudeModelTransitionRestart } from '../launch/claude-structured-options'
import {
  finishPermissionCatchUp,
  openPermissionTestSession,
  permissionTestSession,
  refuseClaudePermission
} from './__tests__/claude-permission.test-fixture'
import { claudeInPlan } from './claude-full-access-refusal'
import { leaveClaudePlanModeOnApproval } from './claude-plan-approval-mode'
import { pickClaudePermissionMode } from './claude-permission-picks'
import { setClaudeAllowedPermissionMode } from './claude-permission-mode-ladder'
import { applyKeptClaudeModeOwed, applyLive } from '../../relay/claude-kept-permission'

const startupWarning =
  "Claude didn't start this chat in Approve for me, so Claude uses Ask for approval instead."

it('keeps Claude running on a model change after the first prompt uses Plan', async () => {
  const { session, writes, frame } = permissionTestSession('auto')
  await openPermissionTestSession(session, 'auto')
  finishPermissionCatchUp(session)

  await applyClaudeMessageOptions(session, { interactionMode: 'plan' }, undefined)
  expect(writes).toEqual(['plan'])
  frame('init', 'plan')

  const restart = claudeModelTransitionRestart(new Map([['session', session]]))
  expect(
    restart({ sessionId: 'session', fence: 1, executionOptions: { model: 'next-model' } })
  ).toBe(false)
})

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
  // Sent on the SDK's queued call, a tick after the request; Claude's init lands meanwhile.
  await setImmediate()
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
  // Sent on the SDK's queued call, a tick after the request.
  await setImmediate()
  expect(writes).toEqual(['plan', 'default'])
  expect(rows).toEqual([])

  askAcknowledged.resolve()
  await setImmediate()
  expect(session.appliedInputOptions.get('buildPermissionMode')).toBe('default')
  expect(rows).toEqual([startupWarning])
})

it('waits for the Build Ask acknowledgement after Plan is rejected', async () => {
  const planAcknowledged = Promise.withResolvers<void>()
  const askStarted = Promise.withResolvers<void>()
  const askAcknowledged = Promise.withResolvers<void>()
  const { session, rows, writes, frame } = permissionTestSession('auto', (mode) => {
    if (mode === 'plan') {
      return planAcknowledged.promise
    }
    askStarted.resolve()
    return askAcknowledged.promise
  })
  await openPermissionTestSession(session, 'auto')
  await session.startupSettings
  finishPermissionCatchUp(session)

  const plan = applyClaudeMessageOptions(session, { interactionMode: 'plan' }, undefined)
  // Sent on the SDK's queued call, a tick after the request; Claude's init lands meanwhile.
  await setImmediate()
  frame('init', 'default')
  expect(writes).toEqual(['plan'])
  expect(rows).toEqual([])

  planAcknowledged.reject(new Error('Claude refused Plan'))
  await expect(plan).rejects.toThrow('Claude refused Plan')
  const build = applyClaudeMessageOptions(session, { interactionMode: 'default' }, undefined)
  await Promise.race([askStarted.promise, build])
  expect(writes).toEqual(['plan', 'default'])
  expect(session.appliedInputOptions.get('buildPermissionMode')).toBeUndefined()
  expect(rows).toEqual([])

  askAcknowledged.resolve()
  await build
  expect(session.appliedInputOptions.get('buildPermissionMode')).toBe('default')
  expect(rows).toEqual([startupWarning])
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

it('sends Approve for me for a live pick made after Claude opened in Ask', async () => {
  const { session, writes, rows, frame } = permissionTestSession('auto')
  await openPermissionTestSession(session, 'default')
  await session.startupSettings
  finishPermissionCatchUp(session)
  frame('init', 'default')
  const shown = [...rows]

  // How Claude opened predates the pick, so it is no evidence against Approve for me.
  pickClaudePermissionMode(session, 'auto')
  expect(await setClaudeAllowedPermissionMode(session, 'auto')).toBe('auto')
  expect(writes).toEqual(['auto'])
  expect(rows).toEqual(shown)
})

it('sends a message at once when its Ask fallback is already running and settings are pending', async () => {
  const { session, writes, frame } = permissionTestSession('auto')
  await openPermissionTestSession(session, 'auto', () => new Promise(() => {}))
  finishPermissionCatchUp(session)
  frame('init', 'default')
  expect(session.appliedInputOptions.get('buildPermissionMode')).toBe('default')

  const send = applyClaudeMessageOptions(session, {}, undefined)
  expect(await Promise.race([send.then(() => 'sent'), setImmediate('waiting')])).toBe('sent')
  expect(writes).toEqual([])
})

it("sends no re-Ask for a kept agent's owed Approve for me once its send is aborted", async () => {
  const send = new AbortController()
  const { session, writes } = permissionTestSession('auto', async (mode) => {
    if (mode === 'auto') {
      send.abort()
      throw new ClaudeControlRequestTimeoutError('set_permission_mode')
    }
  })
  await openPermissionTestSession(session, 'auto')
  finishPermissionCatchUp(session)
  session.keptModeOwed = 'auto'

  await applyKeptClaudeModeOwed(session, undefined, send.signal).catch(() => {})
  await setImmediate()
  expect(writes).toEqual(['auto'])
})

it("keeps a kept agent's owed Ask for the next message when its write is withheld", async () => {
  const { session, writes } = permissionTestSession('auto')
  await openPermissionTestSession(session, 'auto')
  finishPermissionCatchUp(session)
  session.keptModeOwed = 'default'
  const send = new AbortController()
  send.abort()

  await applyKeptClaudeModeOwed(session, undefined, send.signal).catch(() => {})
  expect(writes).toEqual([])
  expect(session.keptModeOwed).toBe('default')
})

it("owes a kept agent's live pick to the next message when a cut withholds its write", async () => {
  const { session, writes } = permissionTestSession('bypassPermissions')
  await openPermissionTestSession(session, 'bypassPermissions')
  finishPermissionCatchUp(session)
  Object.assign(session.connection, { kept: {} })
  // An admitted close holds its cut; its end may still fail and release it.
  session.permissionDispatchCuts = 1

  await applyLive(
    new Map([['chat', session]]),
    () => undefined
  )({
    sessionId: 'chat',
    fence: session.fence,
    mode: 'ask'
  })
  expect(writes).toEqual([])
  expect(session.keptModeOwed).toBe('default')
})
