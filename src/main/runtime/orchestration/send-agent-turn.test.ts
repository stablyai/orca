import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentSessionSendResult } from '../../../shared/agent-session-wire'
import type { AgentMessageSource } from '../../../shared/agent-session-message-source'
import { ORCHESTRATION_READINESS_TIMEOUT_MS } from '../../../shared/orchestration-timing-budgets'
import { dispatchPreambleSendOptions } from './preamble'
import {
  sendAgentTurn,
  type StructuredAgentTurnHost,
  type StructuredSessionTurn
} from './send-agent-turn'

function submissionOf(
  dispatchState: AgentJournalSubmission['dispatchState']
): AgentJournalSubmission {
  return {
    clientMessageId: 'op-1',
    fence: 7,
    payloadFingerprint: 'fp',
    providerItemId: null,
    submittedAt: 1,
    resolvedAt: null,
    dispatchState,
    reason: null
  }
}

type HostSendAnswer = Awaited<ReturnType<StructuredAgentTurnHost['send']>>

const accepted = (value: AgentSessionSendResult): HostSendAnswer => ({
  ok: true,
  replayed: false,
  fence: 7,
  cursor: { epoch: 'e', sequence: 1 },
  value
})

function structuredHost(answer: HostSendAnswer, settled?: AgentJournalSubmission | 'throws') {
  const send = vi.fn(async () => answer)
  const waitForSendSettlement = vi.fn(async () => {
    if (settled === 'throws') {
      throw new Error('agent session send disappeared before settlement')
    }
    return settled
      ? {
          cursor: { epoch: 'e', sequence: 2 },
          value: { clientMessageId: 'op-1', submission: settled }
        }
      : undefined
  })
  const host: StructuredAgentTurnHost = { send, waitForSendSettlement }
  return { host, send, waitForSendSettlement }
}

const MAIL_SOURCE: AgentMessageSource = {
  kind: 'agent',
  senders: [
    {
      party: { address: 'term_peer', terminalHandle: 'term_peer', orcaSessionId: null },
      name: 'Claude'
    }
  ],
  orchestration: {
    message: 'mail-notice',
    mailbox: 'dispatch:d1',
    dispatchId: 'd1',
    messages: [{ messageId: 'm1', runId: 'r1', from: 'term_peer' }]
  }
}

const turn: StructuredSessionTurn = {
  body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] },
  delivery: 'now',
  operationId: 'op-1',
  expectedRuntimeFence: 7
}

const mailTurn: StructuredSessionTurn = {
  ...turn,
  body: { ...turn.body, from: MAIL_SOURCE },
  delivery: 'queue'
}

const structured = (host: StructuredAgentTurnHost, sent: StructuredSessionTurn = turn) =>
  ({
    kind: 'structured-session',
    host,
    sessionId: 's1',
    callerKey: 'trusted-local:k',
    turn: sent
  }) as const

/** What the host digests for a send, so an envelope that disagrees is refused before the ledger. */
const hostFingerprint = (fields: Record<string, unknown>) =>
  computeAgentSessionPayloadFingerprint({ method: 'agentSession.send', sessionId: 's1', fields })

describe('sendAgentTurn to a structured session', () => {
  it('sends `now` as the composer path with no delivery, so a busy chat is steered as today', async () => {
    const fake = structuredHost(
      accepted({ clientMessageId: 'op-1', submission: submissionOf('accepted') })
    )
    await expect(sendAgentTurn(structured(fake.host))).resolves.toEqual({
      kind: 'sent',
      clientMessageId: 'op-1',
      submission: submissionOf('accepted')
    })
    // The body-only digest every orchestration send carried before it was derived here.
    expect(fake.send).toHaveBeenCalledWith(
      { callerKey: 'trusted-local:k' },
      {
        envelope: {
          sessionId: 's1',
          clientOperationId: 'op-1',
          expectedRuntimeFence: 7,
          payloadFingerprint: hostFingerprint({ body: turn.body })
        },
        body: turn.body
      }
    )
    expect(fake.waitForSendSettlement).not.toHaveBeenCalled()
  })

  it('waits a pending send out through the host settlement waiter', async () => {
    const fake = structuredHost(
      accepted({ clientMessageId: 'op-1', submission: submissionOf('pending') }),
      submissionOf('accepted')
    )
    await expect(sendAgentTurn(structured(fake.host))).resolves.toMatchObject({
      kind: 'sent',
      submission: { dispatchState: 'accepted' }
    })
    expect(fake.waitForSendSettlement).toHaveBeenCalledWith('s1', 'op-1', {
      budgetMs: ORCHESTRATION_READINESS_TIMEOUT_MS
    })
  })

  it('answers a send into a running turn at its hand-off, with no start to wait out', async () => {
    const fake = structuredHost(
      accepted({ clientMessageId: 'op-1', submission: submissionOf('pending') }),
      submissionOf('accepted')
    )
    await expect(
      sendAgentTurn(structured(fake.host, { ...turn, awaitsStart: false }))
    ).resolves.toMatchObject({ kind: 'sent', submission: { dispatchState: 'pending' } })
    expect(fake.waitForSendSettlement).not.toHaveBeenCalled()
  })

  it('keeps the first answer when the wait runs out or fails', async () => {
    for (const settled of [undefined, 'throws'] as const) {
      const fake = structuredHost(
        accepted({ clientMessageId: 'op-1', submission: submissionOf('pending') }),
        settled
      )
      await expect(sendAgentTurn(structured(fake.host))).resolves.toMatchObject({
        kind: 'sent',
        submission: { dispatchState: 'pending' }
      })
    }
  })

  it('returns the host refusal for the caller to read', async () => {
    const refusal = { code: 'agent_session_conflict' as const, message: 'conflict' }
    const fake = structuredHost({ ok: false, refusal })
    await expect(sendAgentTurn(structured(fake.host))).resolves.toEqual({
      kind: 'refused',
      refusal
    })
  })

  it('asks the host queue to hold a `queue` send, fingerprinted without its sender', async () => {
    const fake = structuredHost(
      accepted({
        clientMessageId: 'op-1',
        queued: { messageId: 'op-1', position: 0, state: 'waiting' }
      })
    )
    await expect(sendAgentTurn(structured(fake.host, mailTurn))).resolves.toEqual({
      kind: 'queued',
      clientMessageId: 'op-1',
      queued: { messageId: 'op-1', position: 0, state: 'waiting' }
    })
    expect(fake.send).toHaveBeenCalledWith(
      { callerKey: 'trusted-local:k' },
      {
        envelope: {
          sessionId: 's1',
          clientOperationId: 'op-1',
          expectedRuntimeFence: 7,
          // The sender rides on the body, outside the fingerprint: a retry still replays.
          payloadFingerprint: hostFingerprint({ body: turn.body, delivery: 'queue-if-active' })
        },
        body: mailTurn.body,
        delivery: 'queue-if-active'
      }
    )
    expect(fake.waitForSendSettlement).not.toHaveBeenCalled()
  })

  it('keeps the state of a replayed draft that already settled', async () => {
    const fake = structuredHost(
      accepted({
        clientMessageId: 'op-1',
        queued: { messageId: 'op-1', position: 0, state: 'returned' }
      })
    )
    await expect(sendAgentTurn(structured(fake.host, mailTurn))).resolves.toMatchObject({
      kind: 'queued',
      queued: { state: 'returned' }
    })
  })
})

describe('sendAgentTurn to a terminal', () => {
  it('types a dispatch preamble with its own options and hands back the primitive promise itself', async () => {
    const receipt = { handle: 'term_1', accepted: true, bytesWritten: 5 }
    const written = Promise.resolve(receipt)
    const runtime = { sendTerminalAgentPrompt: vi.fn(() => written) }
    const sent = sendAgentTurn({
      kind: 'terminal',
      runtime,
      handle: 'term_1',
      turn: { purpose: 'dispatch-preamble', body: 'hello', operationId: 'req-1' }
    })
    // The same promise, so a caller's await takes no extra tick.
    expect(sent).toBe(written)
    await expect(sent).resolves.toBe(receipt)
    expect(runtime.sendTerminalAgentPrompt).toHaveBeenCalledWith(
      'term_1',
      'hello',
      dispatchPreambleSendOptions('req-1')
    )
  })

  it('propagates a failed write as the primitive threw it', async () => {
    const failure = new Error('terminal_not_writable')
    const runtime = {
      sendTerminalAgentPrompt: vi.fn(async () => {
        throw failure
      })
    }
    await expect(
      sendAgentTurn({
        kind: 'terminal',
        runtime,
        handle: 'term_1',
        turn: { purpose: 'dispatch-preamble', body: 'hello', operationId: 'req-1' }
      })
    ).rejects.toBe(failure)
  })
})
