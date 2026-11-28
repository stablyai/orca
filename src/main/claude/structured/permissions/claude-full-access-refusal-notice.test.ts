import { setImmediate } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { ClaudeControlRequestTimeoutError } from '../../sdk-transport/claude-agent-sdk-control-requests'
import type { ClaudeSession } from '../claude-structured-session-state'
import type { JournalSqlReads } from '../../../native-chat/agent-session-journal/journal-sql-reads'
import { applyClaudeMessageOptions } from '../launch/claude-structured-message-options'
import { readClaudeEarlierRefusalNotice } from './claude-permission-notice-history'
import { adoptClaudeLaunchRootInit } from './claude-permission-startup'
import { acquireFullAccessPermissionTestSession } from './__tests__/claude-permission-acquisition.test-fixture'
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

const UNCONFIRMED = "Full access is off, and Claude hasn't confirmed which approval mode it uses."
const unanswered = (mode: string) =>
  mode === 'auto'
    ? Promise.reject(new ClaudeControlRequestTimeoutError('set_permission_mode'))
    : Promise.resolve()

const histories: {
  history: string
  lookup: JournalSqlReads['newestItemId']
  warned: string[]
}[] = [
  {
    history: 'a saved Full access recovery',
    lookup: async () => savedNotice('restored:bypassPermissions'),
    warned: [UNCONFIRMED]
  },
  {
    history: 'both lookups failing',
    lookup: async () => {
      throw new Error('Reader exited')
    },
    warned: [UNCONFIRMED]
  },
  {
    history: 'no saved row',
    lookup: async () => ({ itemId: null, greatestTimedId: null }),
    warned: []
  }
]

it.each(histories)(
  'with $history, Ask acknowledged and Auto unanswered writes nothing more',
  async ({ lookup, warned }) => {
    const { session, rows, writes } = permissionTestSession('bypassPermissions', unanswered)
    await openPermissionTestSession(session, 'default', async () => ({
      effective: { permissions: { disableBypassPermissionsMode: 'disable' } }
    }))
    await session.startupSettings
    await readClaudeEarlierRefusalNotice(session, { newestItemId: lookup }, () => {})
    finishPermissionCatchUp(session)

    await applyClaudeMessageOptions(session, {}, undefined)
    expect(rows).toEqual(warned)
    expect(writes).toEqual(['default', 'auto'])
    // Unconfirmed: nothing is cached, so the next send asks again, as before this warning.
    expect(session.appliedInputOptions.get('buildPermissionMode')).toBeUndefined()
    expect(session.fullAccessRefusalNoticeId).not.toBe('history-unread')
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

it.each([
  { outcome: 'open', initDuringLookup: false, sent: ['default', 'auto'], warned: [UNCONFIRMED] },
  { outcome: 'open', initDuringLookup: true, sent: ['default', 'auto'], warned: [UNCONFIRMED] },
  { outcome: 'plan', initDuringLookup: false, sent: ['plan'], warned: [] },
  { outcome: 'close', initDuringLookup: false, sent: [], warned: [] }
])(
  'leaves a root init seen before open to open: $outcome (init during lookup $initDuringLookup)',
  async ({ outcome, initDuringLookup, sent, warned }) => {
    const saved = savedNotice('restored:bypassPermissions')
    const lookup = Promise.withResolvers<typeof saved>()
    const { session, rows, writes, init, bind, open, cancel } =
      await acquireFullAccessPermissionTestSession(() => lookup.promise, unanswered)
    if (!initDuringLookup) {
      init()
    }
    bind()
    const opened = open()
    await setImmediate()
    if (initDuringLookup) {
      init()
    }
    expect(writes).toEqual([])
    const plan =
      outcome === 'plan'
        ? applyClaudeMessageOptions(session, { interactionMode: 'plan' }, undefined)
        : undefined
    if (outcome === 'close') {
      cancel()
    }
    lookup.resolve(saved)
    await opened.catch(() => {})
    await plan
    await setImmediate()

    expect(writes).toEqual(sent)
    expect(rows).toEqual(warned)
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

it('posts the accepted startup fallback at once, below a saved Full access recovery', async () => {
  const { session, rows, writes, frame } = permissionTestSession('bypassPermissions')
  await openPermissionTestSession(session, 'default', async () => ({
    effective: { permissions: { disableBypassPermissionsMode: 'disable' } }
  }))
  await session.startupSettings
  await readClaudeEarlierRefusalNotice(
    session,
    { newestItemId: async () => savedNotice('restored:bypassPermissions') },
    () => {}
  )
  frame('init', 'default')
  finishPermissionCatchUp(session)
  await setImmediate()

  // No later turn is needed for the row: Claude may sit idle after accepting the fallback.
  expect(writes).toEqual(['default', 'auto'])
  expect(rows).toEqual([
    "Claude's settings turn off Full access (permissions.disableBypassPermissionsMode), so Claude uses Approve for me instead."
  ])
})
