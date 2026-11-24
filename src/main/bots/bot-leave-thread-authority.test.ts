import { describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../shared/agent-session/journal/agent-session-journal-types'
import { leaveThreadRefusal } from './bot-leave-thread-authority'

const THREAD = { source: 'slack', externalId: 'T1:C1:1800000000.000100:U0BOT' }
const REF = 'slack:T1:C1:1800000000.000100:1800000000.000200'

let sequence = 0
const row = (itemId: string, body: unknown, extra: Partial<AgentJournalRenderItem> = {}) =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: journal rows with only the fields the check reads.
  ({
    itemId,
    revision: 1,
    sequence: ++sequence,
    observedAt: sequence,
    body,
    ...extra
  }) as AgentJournalRenderItem

const person = (role = 'member', extra: Record<string, unknown> = {}) => ({
  role,
  userId: 'U1',
  messageRef: REF,
  ...extra
})
const fromThread = (asker: unknown, extra: Record<string, unknown> = {}) => ({
  kind: 'message',
  role: 'user',
  text: 'please leave this thread',
  origin: 'connector',
  asker,
  connectorConversation: THREAD,
  leaveEligible: true,
  ...extra
})
const typedInOrca = { kind: 'message', role: 'user', text: 'leave this thread' }

/** A turn running now, opened by `opener`, after an earlier finished turn a person asked in. */
function running(opener: unknown, steered: unknown[] = []) {
  sequence = 0
  return [
    row('u0', fromThread(person())),
    row('t0', { kind: 'turn', turnId: 'p0', state: 'completed', userItemId: 'u0' }),
    row('u1', opener),
    row('t1', { kind: 'turn', turnId: 'p1', state: 'running', userItemId: 'u1' }),
    ...steered.map((body, index) =>
      row(`s${index}`, body, { turnScope: { kind: 'turn', turnItemId: 't1' } })
    )
  ]
}

// Hardcoded: who may make a bot leave its thread, from Orca's own record of the running turn.
const cases: [string, AgentJournalRenderItem[], ReturnType<typeof leaveThreadRefusal>][] = [
  ['a member asking in this thread', running(fromThread(person())), null],
  ['the owner asking in this thread', running(fromThread(person('owner'))), null],
  ['the owner typing in Orca', running(typedInOrca), null],
  ['two people in this thread', running(fromThread(person()), [fromThread(person('owner'))]), null],
  [
    'another Slack app',
    running(fromThread(person('member', { app: true }))),
    'leave_refused_mixed'
  ],
  [
    'an Orca bot writing for someone',
    running(fromThread(person('member', { via: { userId: 'U0TWO' } }))),
    'leave_refused_mixed'
  ],
  ['someone Orca can’t name', running(fromThread(person('unknown'))), 'leave_refused_mixed'],
  [
    'a message from another thread',
    running(
      fromThread(
        person('member', { messageRef: 'slack:T1:C1:1800000000.000900:1800000000.000901' })
      )
    ),
    'leave_refused_mixed'
  ],
  [
    'a message delivered for another conversation',
    running(
      fromThread(person(), {
        connectorConversation: { ...THREAD, externalId: 'T1:C1:1800000000.000100:U0TWO' }
      })
    ),
    'leave_refused_mixed'
  ],
  // A worker's report woke the chat: the person's request before it never counts.
  [
    'a worker’s report after a person’s turn',
    running({ ...typedInOrca, from: { sessionId: 'worker-1' } }),
    'leave_refused_mixed'
  ],
  [
    'an automation’s run',
    running({ ...typedInOrca, automationRun: { runId: 'r1' } }),
    'leave_refused_mixed'
  ],
  [
    'a batch that carried another app’s message',
    running(fromThread(person(), { leaveEligible: undefined })),
    'leave_refused_mixed'
  ],
  [
    'a person and an app in one turn',
    running(fromThread(person()), [fromThread(person('member', { app: true }))]),
    'leave_refused_mixed'
  ],
  [
    'a memory the chat recalled',
    running(fromThread(person(), { memorySource: { kind: 'x' } })),
    'leave_refused_mixed'
  ]
]

describe('who may make a bot leave its Slack thread', () => {
  it.each(cases)('%s', (_name, items, refusal) => {
    expect(leaveThreadRefusal(items, [], THREAD)).toBe(refusal)
  })

  it('never from a turn that is over, or one that took no message', () => {
    sequence = 0
    const asked = row('u0', fromThread(person()))
    const done = row('t0', { kind: 'turn', turnId: 'p0', state: 'completed', userItemId: 'u0' })
    expect(leaveThreadRefusal([asked, done], [], THREAD)).toBe('leave_refused_stale')
    // A running turn no message opened: the person's earlier request is never borrowed.
    const bare = row('t1', { kind: 'turn', turnId: 'p1', state: 'running' } satisfies Partial<
      Extract<AgentJournalItemBody, { kind: 'turn' }>
    >)
    expect(leaveThreadRefusal([asked, done, bare], [], THREAD)).toBe('leave_refused_stale')
    expect(leaveThreadRefusal([], [], THREAD)).toBe('leave_refused_stale')
  })
})
