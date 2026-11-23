import { expect, it } from 'vitest'
import type { ClaudeDispatchWaiter, ClaudeSession } from '../claude-structured-session-state'
import { claudeFrameSendFacts, claudeHandedSends } from './claude-command-lifecycle'

const waiter = (clientMessageId: string | null, extra: Partial<ClaudeDispatchWaiter> = {}) =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reader uses only the id and state fields.
  ({ clientMessageId, ...extra }) as ClaudeDispatchWaiter

const session = (parts: Partial<ClaudeSession>) =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reader uses only the send lists.
  ({ dispatchWaiters: [], retiredDispatchWaiters: [], ...parts }) as ClaudeSession

it('lists every send Orca handed Claude in any state, and none it can’t name as unnamed', () => {
  const held = session({
    dispatchWaiters: [
      waiter('queued', { commandLifecycle: 'queued' }),
      waiter('started', { commandLifecycle: 'started' }),
      waiter('steer', { steers: true }),
      waiter('written')
    ],
    retiredDispatchWaiters: [waiter('in-doubt', { retired: true })],
    unreportedSettlements: new Set(['settled'])
  })
  expect(claudeHandedSends(held)).toEqual({
    ids: ['queued', 'started', 'steer', 'written', 'in-doubt', 'settled'],
    unnamed: false
  })
  expect(claudeHandedSends(session({ dispatchWaiters: [waiter(null)] })).unnamed).toBe(true)
  expect(claudeHandedSends(null).unnamed).toBe(true)
})

it('reads the list onto a task’s start only', () => {
  const held = session({ dispatchWaiters: [waiter('c9')] })
  const started = { type: 'system', subtype: 'task_started', task_id: 'b1', tool_use_id: 'toolu_1' }
  expect(claudeFrameSendFacts(held, started, false).handedSends).toEqual({
    ids: ['c9'],
    unnamed: false
  })
  expect(claudeFrameSendFacts(held, { type: 'assistant' }, false).handedSends).toBeUndefined()
})

it('marks every frame while Orca holds a handed send, with nothing built per frame', () => {
  const delta = { type: 'stream_event' }
  const idle = claudeFrameSendFacts(session({}), delta, false)
  expect(idle.handedPending).toBeUndefined()
  const held = [
    session({ dispatchWaiters: [waiter('c9')] }),
    session({ retiredDispatchWaiters: [waiter('in-doubt', { retired: true })] }),
    session({ unreportedSettlements: new Set(['settled']) }),
    null
  ].map((parts) => claudeFrameSendFacts(parts, delta, false))
  expect(held.every((facts) => facts.handedPending)).toBe(true)
  expect(held[0]).toBe(held[1])
})
