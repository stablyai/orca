import { afterEach, describe, expect, it } from 'vitest'
import type { AgentMessageSource } from '../../../../../shared/agent-session/journal/agent-session-message-source'
import { agentSessionFailureFact } from '../../../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../../../shared/agent-session/failures/agent-session-failure-words'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD
} from './structured-agent-session-host-test-data.test-fixture'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import { eventually } from './structured-agent-session-queued-message-rig-provider.test-fixture'

// Another agent's mail behind a failed turn runs as the next turn, except after a usage limit; the
// person's own queued follow-ups stay held until the chat continues.
let rig: QueuedMessageTestRig

afterEach(() => rig.dispose())

const MAIL: AgentMessageSource = {
  kind: 'agent',
  senders: [],
  orchestration: { message: 'mail-notice', mailbox: 'term_b', dispatchId: null, messages: [] }
}

function journal() {
  return rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
}

async function failedTurn(name: string): Promise<string> {
  const key = { provider: 'orca' as const, clientMessageId: `turn-${name}` }
  await journal().appendItem(
    key,
    {
      kind: 'turn',
      turnId: name,
      providerTurnId: name,
      state: 'completed',
      outcome: 'failure',
      startedAt: HOST_TEST_NOW,
      completedAt: HOST_TEST_NOW
    },
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  return agentJournalItemKey(key)
}

async function failAtUsageLimit(): Promise<void> {
  const turnItemId = await failedTurn('limited')
  await journal().appendItem(
    { provider: 'orca', clientMessageId: 'limited-limit' },
    {
      kind: 'status',
      ...agentSessionFailureWords(
        agentSessionFailureFact('usageLimitReached', {
          usageLimit: { resetsAt: HOST_TEST_NOW + 60_000 }
        }),
        { surface: 'row' }
      )
    },
    { fence: 1, turnScope: { kind: 'turn', turnItemId } }
  )
}

/** The provider's turn for the person's send `id`. */
async function providerTurn(
  id: string,
  state: 'running' | 'completed' | 'interrupted',
  outcome?: 'failure'
) {
  await journal().appendItem(
    { provider: 'codex', threadId: THREAD, turnId: `turn-of-${id}`, ordinal: 0 },
    {
      kind: 'turn',
      turnId: `turn-of-${id}`,
      startedAt: HOST_TEST_NOW,
      userItemId: agentJournalSubmissionKey(id),
      ...(outcome ? { outcome } : {}),
      ...(state === 'running' ? { state } : { state, completedAt: HOST_TEST_NOW })
    },
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
}

/** A running turn with the person's follow-up queued behind it; resolves to both ids. */
async function personQueued(): Promise<{ working: string; followUp: string }> {
  const working = await rig.workingSend()
  await rig.settleAccepted(working, 'working')
  await providerTurn(working, 'running')
  const result = await rig.send('then fix the tests', 'queue-if-active').result
  if (!result.ok || !('queued' in result.value)) {
    throw new Error(`expected a queued follow-up, got ${JSON.stringify(result)}`)
  }
  return { working, followUp: result.value.queued.messageId }
}

/** Another agent's mail; the card id when it queued, or the send id when it ran at once. */
async function mail(): Promise<{ queued?: string; sent?: string }> {
  const send = rig.send('update the install docs', 'queue-if-active', {
    internal: true,
    from: MAIL
  })
  const result = await send.result
  if (!result.ok) {
    throw new Error(`mail refused: ${JSON.stringify(result)}`)
  }
  return 'queued' in result.value ? { queued: result.value.queued.messageId } : { sent: send.id }
}

describe("another agent's mail after a failed turn", () => {
  it('runs as the next turn while the person’s follow-up stays held', async () => {
    rig = await createQueuedMessageTestRig()
    const { working, followUp } = await personQueued()
    await providerTurn(working, 'completed', 'failure')
    expect(await rig.queuePause()).toEqual({ reason: 'failed' })
    const sent = await mail()
    expect(sent.queued).toBeUndefined()
    await eventually(async () =>
      expect((await rig.submission(sent.sent!))?.handedOverAt).toBeDefined()
    )
    expect(await rig.handoff(followUp)).toBeUndefined()
  })

  it('already queued behind a send the agent refused, runs after it', async () => {
    rig = await createQueuedMessageTestRig()
    const { working, followUp } = await personQueued()
    await providerTurn(working, 'completed', 'failure')
    const retry = rig.send('try again')
    expect(await retry.result).toMatchObject({ ok: true })
    await eventually(async () =>
      expect((await rig.submission(retry.id))?.handedOverAt).toBeDefined()
    )
    const sent = await mail()
    expect(sent.queued).toBeDefined()
    await rig.settleRejected(retry.id, 'overloaded')
    await eventually(async () =>
      expect((await rig.handoff(sent.queued!))?.handedOverAt).toBeDefined()
    )
    expect(await rig.handoff(followUp)).toBeUndefined()
  })

  it('waits behind a usage limit', async () => {
    rig = await createQueuedMessageTestRig()
    await failAtUsageLimit()
    const sent = await mail()
    expect(sent.queued).toBeDefined()
    expect(await journal().queuedMessages.failureHolds()).toBe(true)
    expect(await rig.handoff(sent.queued!)).toBeUndefined()
  })

  it('waits behind a usage limit while another send is still pending', async () => {
    rig = await createQueuedMessageTestRig()
    await failAtUsageLimit()
    const pending = rig.send('are you there?')
    expect(await pending.result).toMatchObject({ ok: true })
    await eventually(async () =>
      expect((await rig.submission(pending.id))?.dispatchState).toBe('pending')
    )
    expect(await journal().queuedMessages.failureHolds()).toBe(true)
  })

  it('a Stop still holds the person’s follow-up', async () => {
    rig = await createQueuedMessageTestRig()
    const { working, followUp } = await personQueued()
    expect(await rig.stop()).toMatchObject({ ok: true })
    await providerTurn(working, 'interrupted')
    await eventually(async () => expect(await rig.queuePause()).toEqual({ reason: 'stopped' }))
    expect(await rig.handoff(followUp)).toBeUndefined()
  })
})
