import { setImmediate } from 'node:timers/promises'
import { expect, it, vi } from 'vitest'
import { ClaudeControlRequestTimeoutError } from '../../sdk-transport/claude-agent-sdk-control-requests'
import type { ClaudeSession } from '../claude-structured-session-state'
import { applyClaudeMessageOptions } from '../launch/claude-structured-message-options'
import { readClaudeEarlierRefusalNotice } from './claude-full-access-refusal-notice'
import {
  adoptClaudeLaunchRootInit,
  readClaudeStartupPermissionNotice
} from './claude-permission-startup'
import {
  finishPermissionCatchUp,
  openPermissionTestSession,
  permissionTestSession,
  refuseClaudePermission,
  savedNotice
} from './__tests__/claude-permission.test-fixture'

const intents: readonly ('auto' | 'bypassPermissions')[] = ['auto', 'bypassPermissions']

function previousWarning(intent: (typeof intents)[number]) {
  return savedNotice(intent === 'auto' ? 'auto-settings:ask' : 'settings:ask')
}

function replayWarning(session: ClaudeSession, intent: (typeof intents)[number]) {
  return readClaudeEarlierRefusalNotice(
    session,
    { newestItemId: async () => previousWarning(intent) },
    () => {}
  )
}

function recoveryText(intent: (typeof intents)[number]): string {
  return intent === 'auto' ? 'Claude uses Approve for me again.' : 'Claude uses Full access again.'
}

it.each(intents)('recovers %s from a root init buffered before publication', async (intent) => {
  const { session, rows, writes } = permissionTestSession(intent)
  adoptClaudeLaunchRootInit(session, { permissionMode: intent })
  await openPermissionTestSession(session, 'default')
  await replayWarning(session, intent)
  expect(rows).toEqual([])

  finishPermissionCatchUp(session)
  expect(rows).toEqual([recoveryText(intent)])
  expect(writes).toEqual([])
})

it.each(intents)('waits beyond initialize for the live %s root init', async (intent) => {
  const { session, rows, writes, frame } = permissionTestSession(intent)
  await openPermissionTestSession(session, intent)
  await replayWarning(session, intent)
  finishPermissionCatchUp(session)
  expect(rows).toEqual([])

  frame('init', intent)
  frame('status', intent)
  expect(rows).toEqual([recoveryText(intent)])
  expect(writes).toEqual([])
})

it.each(['current', 'previous'])(
  'replaces a %s-process Auto recovery after unanswered Auto and acknowledged Ask',
  async (recoveryProcess) => {
    const { session, rows, writes, frame } = permissionTestSession('auto', async (mode) => {
      if (mode === 'auto') {
        if (recoveryProcess === 'current') {
          throw new ClaudeControlRequestTimeoutError('set_permission_mode')
        }
        await refuseClaudePermission('internal_error')
      }
    })
    await openPermissionTestSession(session, 'auto')
    const saved = recoveryProcess === 'previous'
    await readClaudeEarlierRefusalNotice(
      session,
      {
        newestItemId: async () => (saved ? savedNotice('restored:auto') : previousWarning('auto'))
      },
      () => {}
    )
    finishPermissionCatchUp(session)
    frame('init', 'auto')
    const initialRows = saved ? [] : ['Claude uses Approve for me again.']
    expect(rows).toEqual(initialRows)

    await applyClaudeMessageOptions(session, { interactionMode: 'default' }, undefined)
    expect(rows).toEqual([
      ...initialRows,
      "Approve for me isn't available right now, so Claude uses Ask for approval instead."
    ])
    expect(session.appliedInputOptions.get('buildPermissionMode')).toBe('default')

    await applyClaudeMessageOptions(session, {}, undefined)
    expect(writes).toEqual(['auto', 'default'])
  }
)

it.each([
  {
    finalAskAcked: true,
    warning:
      "Claude's settings turn off Full access (permissions.disableBypassPermissionsMode) and Approve for me isn't available right now, so Claude uses Ask for approval instead."
  },
  {
    finalAskAcked: false,
    warning: "Full access is off, and Claude hasn't confirmed which approval mode it uses."
  }
])(
  'replaces a saved Full access recovery when final Ask acknowledgement is $finalAskAcked',
  async ({ finalAskAcked, warning }) => {
    let askWrites = 0
    let autoWrites = 0
    const { session, rows, writes, frame } = permissionTestSession(
      'bypassPermissions',
      async (mode) => {
        if (
          (mode === 'auto' && ++autoWrites === 1) ||
          (mode === 'default' && ++askWrites === 2 && !finalAskAcked)
        ) {
          throw new ClaudeControlRequestTimeoutError('set_permission_mode')
        }
      }
    )
    await openPermissionTestSession(session, 'default', async () => ({
      effective: { permissions: { disableBypassPermissionsMode: 'disable' } }
    }))
    await session.startupSettings
    const recovery = recoveryText('bypassPermissions')
    rows.push(recovery)
    await readClaudeEarlierRefusalNotice(
      session,
      { newestItemId: async () => savedNotice('restored:bypassPermissions') },
      () => {}
    )
    finishPermissionCatchUp(session)

    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    try {
      await applyClaudeMessageOptions(session, {}, undefined)
      expect(rows).toEqual([recovery, warning])
      expect(writes).toEqual(['default', 'auto', 'default'])
      const buildMode = finalAskAcked ? 'default' : undefined
      expect(session.appliedInputOptions.get('buildPermissionMode')).toBe(buildMode)
      expect(session.acknowledgedBuildPermissionMode).toBe(buildMode)
      if (!finalAskAcked) {
        clock.mockReturnValue(11_000)
        await applyClaudeMessageOptions(session, {}, undefined)
        expect(writes).toEqual(['default', 'auto', 'default', 'default', 'auto'])
        frame('status', 'auto')
        expect(rows).toEqual([
          recovery,
          warning,
          "Claude's settings turn off Full access (permissions.disableBypassPermissionsMode), so Claude uses Approve for me instead."
        ])
      }
    } finally {
      clock.mockRestore()
    }
  }
)

it('preserves Full access startup decisions when initialize and root disagree', async () => {
  const { session, rows, writes, frame } = permissionTestSession('bypassPermissions')
  await openPermissionTestSession(session, 'bypassPermissions')
  await replayWarning(session, 'bypassPermissions')
  frame('init', 'default')
  finishPermissionCatchUp(session)
  await applyClaudeMessageOptions(session, {}, undefined)

  expect(session.firstRootInit?.permissionMode).toBe('bypassPermissions')
  expect(session.actualFirstRootInit?.permissionMode).toBe('default')
  expect(rows).toEqual([])
  expect(writes).toEqual([])
})

it.each(['fallback', 'plan'])(
  'waits for a saved Full access recovery before %s',
  async (outcome) => {
    const saved = savedNotice('restored:bypassPermissions')
    const delayed = Promise.withResolvers<typeof saved>()
    const planReply = Promise.withResolvers<void>()
    const { session, rows, writes, frame } = permissionTestSession('bypassPermissions', (mode) => {
      if (mode === 'plan') {
        return planReply.promise
      }
      return mode === 'auto' ? refuseClaudePermission('internal_error') : Promise.resolve()
    })
    await openPermissionTestSession(session, 'default')
    const recovery = recoveryText('bypassPermissions')
    rows.push(recovery)
    const read = readClaudeStartupPermissionNotice(
      session,
      { newestItemId: () => delayed.promise },
      () => {}
    )
    frame('init', 'default')
    await setImmediate()
    const plan =
      outcome === 'plan'
        ? applyClaudeMessageOptions(session, { interactionMode: 'plan' }, undefined)
        : undefined
    delayed.resolve(saved)
    await read
    finishPermissionCatchUp(session)
    await setImmediate()

    if (plan) {
      expect(writes).toEqual(['plan'])
      planReply.resolve()
      await plan
      return
    }
    expect(rows).toEqual([
      recovery,
      "Claude didn't start this chat in Full access and Approve for me isn't available right now, so Claude uses Ask for approval instead."
    ])
    expect(writes).toEqual(['default', 'auto', 'default'])
  }
)

it.each(intents)('requires a current %s write after a root init with no mode', async (intent) => {
  const acknowledged = Promise.withResolvers<void>()
  const started = Promise.withResolvers<void>()
  const { session, rows, frame } = permissionTestSession(intent, () => {
    started.resolve()
    return acknowledged.promise
  })
  await openPermissionTestSession(session, intent)
  await replayWarning(session, intent)
  frame('init')
  finishPermissionCatchUp(session)
  frame('init', intent)
  expect(rows).toEqual([])

  const write = applyClaudeMessageOptions(session, { interactionMode: 'default' }, undefined)
  await Promise.race([started.promise, write])
  expect(rows).toEqual([])
  acknowledged.resolve()
  await write
  expect(rows).toEqual([recoveryText(intent)])
})

it.each(intents)(
  'drops buffered %s root proof when a Plan request supersedes it',
  async (intent) => {
    const planStarted = Promise.withResolvers<void>()
    const planAcknowledged = Promise.withResolvers<void>()
    const { session, rows, frame } = permissionTestSession(intent, () => {
      planStarted.resolve()
      return planAcknowledged.promise
    })
    await openPermissionTestSession(session, intent)
    await replayWarning(session, intent)
    frame('init', intent)

    const plan = applyClaudeMessageOptions(session, { interactionMode: 'plan' }, undefined)
    await Promise.race([planStarted.promise, plan])
    finishPermissionCatchUp(session)
    expect(rows).toEqual([])

    planAcknowledged.resolve()
    await plan
    expect(rows).toEqual([])
  }
)

it.each(intents)(
  'ignores a saved warning for a different mode when %s acknowledges',
  async (intent) => {
    const { session, rows } = permissionTestSession(intent)
    await openPermissionTestSession(session, intent)
    await replayWarning(session, intent === 'auto' ? 'bypassPermissions' : 'auto')
    finishPermissionCatchUp(session)

    await applyClaudeMessageOptions(session, { interactionMode: 'default' }, undefined)
    expect(rows).toEqual([])
  }
)

it.each(['before', 'after'])(
  'drops a Build acknowledgement arriving %s a newer Plan request',
  async (arrival) => {
    const acknowledged = Promise.withResolvers<void>()
    const started = Promise.withResolvers<void>()
    const { session, rows } = permissionTestSession('auto', (mode) => {
      if (mode === 'auto') {
        started.resolve()
        return acknowledged.promise
      }
      return Promise.resolve()
    })
    await openPermissionTestSession(session, 'auto')
    await replayWarning(session, 'auto')
    const build = applyClaudeMessageOptions(session, { interactionMode: 'default' }, undefined)
    await Promise.race([started.promise, build])
    if (arrival === 'before') {
      acknowledged.resolve()
      await build
    }

    await applyClaudeMessageOptions(session, { interactionMode: 'plan' }, undefined)
    finishPermissionCatchUp(session)
    acknowledged.resolve()
    await build
    expect(rows).toEqual([])
    expect(session.acknowledgedBuildPermissionMode).toBeUndefined()
  }
)

it('leaves the saved warning in place when delivery retires before acknowledgement', async () => {
  const acknowledged = Promise.withResolvers<void>()
  const started = Promise.withResolvers<void>()
  const { session, rows } = permissionTestSession('auto', () => {
    started.resolve()
    return acknowledged.promise
  })
  await openPermissionTestSession(session, 'auto')
  await replayWarning(session, 'auto')
  finishPermissionCatchUp(session)
  const build = applyClaudeMessageOptions(session, { interactionMode: 'default' }, undefined)
  await Promise.race([started.promise, build])
  session.delivery.dispose()

  acknowledged.resolve()
  await build
  expect(rows).toEqual([])
})
