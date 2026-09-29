import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import type {
  AgentSessionHistoryPage,
  AgentSessionHistoryResult,
  AgentSessionSubscribeEvent
} from '../../../../shared/agent-session-wire'
import { AGENT_SESSION_RECOVERED_SEND_CAPABILITY } from '../../../../shared/protocol-version'
import { structuredAgentSessionSubmissionSettlement } from '../../../../shared/structured-agent-session-submission-settlement'
import type { AgentSessionSubscribeInput } from '../../../native-chat/agent-session-wire/structured-agent-session-subscribers'
import {
  call,
  clearStructuredHostStub,
  FINGERPRINT,
  hostCalls,
  installStructuredHostStub,
  OPERATION,
  sendParams,
  SESSION,
  STRUCTURED_CLIENT
} from './structured-agent-session-rpc.test-fixture'
import {
  projectRecoveredSendEvent,
  projectRecoveredSendHistory,
  projectRecoveredSendResult
} from './structured-agent-session-recovered-send-capability'

beforeEach(installStructuredHostStub)
afterEach(clearStructuredHostStub)

function submission(overrides: Partial<AgentJournalSubmission> = {}): AgentJournalSubmission {
  return {
    clientMessageId: OPERATION,
    fence: 1,
    payloadFingerprint: FINGERPRINT,
    dispatchState: 'unknown',
    providerItemId: null,
    reason: 'host_restarted_before_acknowledgement',
    submittedAt: 1,
    resolvedAt: 2,
    recovered: true,
    handoverRecorded: true,
    handedOverAt: 1,
    ...overrides
  }
}

// A crash left this send in doubt for good: the host's own record of it.
const RECOVERED = Object.freeze(submission())
// The only shape a client that predates the capability draws as an ordinary sent message.
const AS_ACCEPTED: AgentJournalSubmission = {
  clientMessageId: OPERATION,
  fence: 1,
  payloadFingerprint: FINGERPRINT,
  dispatchState: 'accepted',
  providerItemId: null,
  reason: null,
  submittedAt: 1,
  resolvedAt: 2,
  handoverRecorded: true,
  handedOverAt: 1
}
const CURRENT_CLIENT = {
  ...STRUCTURED_CLIENT,
  clientCapabilities: [
    ...STRUCTURED_CLIENT.clientCapabilities,
    AGENT_SESSION_RECOVERED_SEND_CAPABILITY
  ]
}

function page(submissions: AgentJournalSubmission[]): AgentSessionHistoryPage {
  return {
    sessionId: SESSION,
    epoch: 'a',
    direction: 'tail',
    items: [],
    removedItemIds: [],
    submissions,
    window: { oldest: null, newest: null, nextCursor: { epoch: 'a', sequence: 0 } },
    hasOlder: false,
    hasNewer: false
  }
}

describe('a recovered send at the RPC boundary', () => {
  it.each([
    ['older reader', STRUCTURED_CLIENT, AS_ACCEPTED],
    ['current reader', CURRENT_CLIENT, RECOVERED],
    ['in-process reader', undefined, RECOVERED]
  ] as const)('reaches the %s in the shape it draws as sent', async (_label, client, expected) => {
    hostCalls.history.mockReturnValue({ ok: true, page: page([RECOVERED]) })
    const reply = await call(
      'agentSession.history',
      { sessionId: SESSION, direction: 'tail' },
      client
    )
    // Exact, not a subset: a projected send must not keep `recovered`.
    expect(reply).toEqual(
      expect.objectContaining({
        result: expect.objectContaining({
          page: expect.objectContaining({ submissions: [expected] })
        })
      })
    )
  })

  it.each(['snapshot', 'batch', 'reset'] as const)(
    'projects the %s stream only for an older reader',
    async (type) => {
      hostCalls.subscribe.mockImplementation((input: AgentSessionSubscribeInput) => {
        const base = { sessionId: SESSION, fence: 1 }
        if (type === 'batch') {
          input.emit({
            ...base,
            type,
            batch: {
              cursor: { epoch: 'a', sequence: 2 },
              items: [],
              removedItemIds: [],
              submissions: [RECOVERED]
            }
          })
        } else {
          input.emit(
            type === 'snapshot'
              ? { ...base, type, page: page([RECOVERED]) }
              : { ...base, type, page: page([RECOVERED]), reset: 'epoch_changed' }
          )
        }
        return () => {}
      })
      for (const [client, expected] of [
        [STRUCTURED_CLIENT, AS_ACCEPTED],
        [CURRENT_CLIENT, RECOVERED]
      ] as const) {
        const carrier = expect.objectContaining({ submissions: [expected] })
        expect(await call('agentSession.subscribe', { sessionId: SESSION }, client)).toEqual(
          expect.objectContaining({
            result: expect.objectContaining(
              type === 'batch' ? { batch: carrier } : { page: carrier }
            )
          })
        )
      }
    }
  )

  it('answers a replayed send of a recovered message as accepted to an older reader', async () => {
    hostCalls.send.mockResolvedValue({
      ok: true,
      replayed: true,
      fence: 1,
      cursor: { epoch: 'epoch-a', sequence: 1 },
      value: { clientMessageId: OPERATION, submission: RECOVERED }
    })
    for (const [client, expected] of [
      [STRUCTURED_CLIENT, AS_ACCEPTED],
      [CURRENT_CLIENT, RECOVERED]
    ] as const) {
      expect(await call('agentSession.send', sendParams(), client)).toEqual(
        expect.objectContaining({
          result: expect.objectContaining({
            value: { clientMessageId: OPERATION, submission: expected }
          })
        })
      )
    }
  })
})

describe('recovered send projection', () => {
  it('reads as sent on both sides of the capability', () => {
    expect(structuredAgentSessionSubmissionSettlement(RECOVERED)).toBe('sent')
    expect(structuredAgentSessionSubmissionSettlement(AS_ACCEPTED)).toBe('sent')
  })

  it('never touches the host record it projects', () => {
    const history: AgentSessionHistoryResult = { ok: true, page: page([RECOVERED]) }
    const projected = projectRecoveredSendHistory(history, STRUCTURED_CLIENT)
    expect(projected.page.submissions).toEqual([AS_ACCEPTED])
    expect(history.page.submissions[0]).toBe(RECOVERED)
    expect(RECOVERED).toMatchObject({ dispatchState: 'unknown', recovered: true })
  })

  it.each([
    [
      'a live unknown, which can still be answered',
      submission({ recovered: undefined, reason: 'provider_write_outcome_unknown: timeout' })
    ],
    ['a pending send', submission({ dispatchState: 'pending', recovered: undefined })],
    ['a refused send', submission({ dispatchState: 'rejected', reason: 'queue full' })],
    ['an accepted send', submission({ dispatchState: 'accepted', recovered: undefined })]
  ])('leaves %s as the host wrote it', (_label, entry) => {
    const history: AgentSessionHistoryResult = { ok: true, page: page([entry]) }
    expect(projectRecoveredSendHistory(history, STRUCTURED_CLIENT)).toBe(history)
  })

  // An older host's verdicts, still on disk: a current client draws both as sent.
  it.each([
    [
      'an inferred "not delivered"',
      submission({
        dispatchState: 'rejected',
        reason: 'not_delivered',
        rejection: { kind: 'notDelivered' }
      })
    ],
    ['a restart doubt without the recovered flag', submission({ recovered: undefined })]
  ])('publishes %s to an older reader as accepted', (_label, entry) => {
    expect(structuredAgentSessionSubmissionSettlement(entry)).toBe('sent')
    const history: AgentSessionHistoryResult = { ok: true, page: page([entry]) }
    expect(projectRecoveredSendHistory(history, STRUCTURED_CLIENT).page.submissions).toEqual([
      AS_ACCEPTED
    ])
  })

  it.each([
    ['capable client', CURRENT_CLIENT],
    ['in-process caller', {}]
  ] as const)('hands a %s the same object back', (_label, ctx) => {
    const history: AgentSessionHistoryResult = { ok: true, page: page([RECOVERED]) }
    const snapshot: AgentSessionSubscribeEvent = {
      type: 'snapshot',
      sessionId: SESSION,
      fence: 1,
      page: page([RECOVERED])
    }
    const sent = {
      ok: true as const,
      replayed: true,
      fence: 1,
      cursor: { epoch: 'a', sequence: 1 },
      value: { clientMessageId: OPERATION, submission: RECOVERED }
    }
    expect(projectRecoveredSendHistory(history, ctx)).toBe(history)
    expect(projectRecoveredSendEvent(snapshot, ctx)).toBe(snapshot)
    expect(projectRecoveredSendResult(sent, ctx)).toBe(sent)
  })
})
