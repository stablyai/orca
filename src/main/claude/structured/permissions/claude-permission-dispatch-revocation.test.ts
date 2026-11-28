import { setImmediate } from 'node:timers/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { ClaudeControlRequestTimeoutError } from '../../sdk-transport/claude-agent-sdk-control-requests'
import type { ClaudeSession } from '../claude-structured-session-state'
import { applyClaudeMessageOptions } from '../launch/claude-structured-message-options'
import { leaveClaudePlanModeOnApproval } from './claude-plan-approval-mode'
import {
  finishPermissionCatchUp,
  openPermissionTestSession,
  permissionTestSession
} from './__tests__/claude-permission.test-fixture'

// What the host's revocation of this exact child sets (an admitted close, a child-ending Stop,
// sleep, quit, replacement or exit).
const revoke = (session: ClaudeSession) => {
  session.permissionDispatchRevoked = true
}

afterEach(() => vi.restoreAllMocks())

async function inPlan(
  intent: 'auto' | 'bypassPermissions',
  reply?: Parameters<typeof permissionTestSession>[1]
) {
  const fixture = permissionTestSession(intent, reply)
  await openPermissionTestSession(fixture.session, intent)
  finishPermissionCatchUp(fixture.session)
  fixture.session.reportedOptions.reportedPermissionMode = 'plan'
  return fixture
}

const approvePlan = (session: ClaudeSession) =>
  leaveClaudePlanModeOnApproval(session, { toolName: 'ExitPlanMode' }, { behavior: 'allow' })

it('withholds a Plan exit write still queued in the SDK callback when the child is revoked', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const { session, writes, rows } = await inPlan('auto')
  approvePlan(session)
  // The write is queued behind the SDK's `.then(run)`; the cut lands before it runs.
  revoke(session)
  await setImmediate()

  expect(writes).toEqual([])
  expect(rows).toEqual([])
  expect(warn).not.toHaveBeenCalled()
})

it("sends no Approve for me re-Ask after the child is revoked during Auto's answer", async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const { session, writes, rows } = await inPlan('auto', async (mode) => {
    if (mode === 'auto') {
      revoke(session)
      throw new ClaudeControlRequestTimeoutError('set_permission_mode')
    }
  })
  approvePlan(session)
  await setImmediate()

  expect(writes).toEqual(['auto'])
  expect(rows).toEqual([])
  expect(warn).not.toHaveBeenCalled()
})

it("sends no Approve for me re-Ask once Build's own operation is aborted", async () => {
  const send = new AbortController()
  const { session, writes, rows } = permissionTestSession('auto', async (mode) => {
    if (mode === 'auto') {
      send.abort()
      throw new ClaudeControlRequestTimeoutError('set_permission_mode')
    }
  })
  await openPermissionTestSession(session, 'auto')
  finishPermissionCatchUp(session)

  await expect(
    applyClaudeMessageOptions(session, { interactionMode: 'default' }, undefined, send.signal)
  ).rejects.toThrow()
  await setImmediate()
  expect(writes).toEqual(['auto'])
  expect(rows).toEqual([])
})

it('starts no Full access fallback from a root init that arrives after the child is revoked', async () => {
  const { session, writes, rows, frame } = permissionTestSession('bypassPermissions')
  await openPermissionTestSession(session, 'bypassPermissions')
  finishPermissionCatchUp(session)
  revoke(session)
  frame('init', 'default')
  await setImmediate()

  expect(writes).toEqual([])
  expect(rows).toEqual([])
})
