import { expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { ClaudeSession } from '../claude-structured-session-state'
import { applyClaudeMessageOptions } from '../launch/claude-structured-message-options'
import {
  claimClaudeFullAccessRefusalNotice,
  readClaudeEarlierRefusalNotice
} from './claude-full-access-refusal-notice'
import { adoptClaudeLaunchRootInit } from './claude-permission-startup'
import {
  finishPermissionCatchUp,
  openPermissionTestSession,
  permissionTestSession
} from './__tests__/claude-permission.test-fixture'

const intents: readonly ('auto' | 'bypassPermissions')[] = ['auto', 'bypassPermissions']

function previousWarning(intent: (typeof intents)[number]) {
  const notice = intent === 'auto' ? 'auto-settings:ask' : 'settings:ask'
  const itemId = agentJournalItemKey({
    provider: 'orca',
    clientMessageId: `full-access-refused:claude:t0000000001:earlier:1:${notice}`
  })
  return { itemId, greatestTimedId: itemId }
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

it('recovers the earlier warning after one transient journal lookup failure', async () => {
  const { session, frame, rows } = permissionTestSession('bypassPermissions')
  const newestItemId = vi
    .fn()
    .mockRejectedValueOnce(new Error('Reader exited'))
    .mockResolvedValueOnce(previousWarning('bypassPermissions'))
  await readClaudeEarlierRefusalNotice(session, { newestItemId }, () => {})

  frame('init', 'bypassPermissions')
  finishPermissionCatchUp(session)
  expect(rows).toEqual(['Claude uses Full access again.'])
})

it('sorts permission notice IDs across a base-36 digit boundary', () => {
  const clock = vi.spyOn(Date, 'now')
  const noticeAt = (time: number) => {
    clock.mockReturnValue(time)
    const { session } = permissionTestSession('auto')
    session.autoDisabled = true
    session.appliedInputOptions.set('buildPermissionMode', 'default')
    session.initialization.startup.open()
    return claimClaudeFullAccessRefusalNotice(session)?.id
  }
  try {
    const before = noticeAt(36 ** 8 - 1)
    const after = noticeAt(36 ** 8)
    expect(before).toMatch(/^t00zzzzzzzz:/)
    expect(after).toMatch(/^t0100000000:/)
    expect([after, before].sort()).toEqual([before, after])
  } finally {
    clock.mockRestore()
  }
})
