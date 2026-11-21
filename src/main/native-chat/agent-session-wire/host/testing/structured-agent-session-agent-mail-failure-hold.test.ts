import { readTestHostJournal } from '../../../agent-session-journal/journal-observation.test-support'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentMessageSource } from '../../../../../shared/agent-session/journal/agent-session-message-source'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION as SESSION
} from './structured-agent-session-host-test-data.test-fixture'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import { eventually } from './structured-agent-session-queued-message-rig-provider.test-fixture'
import { openRigTurnFor } from './structured-agent-session-queued-rig-turn.test-fixture'
import { appendRewindUsageLimitedTurn } from './structured-agent-session-rewind-usage-limit.test-fixture'

// Another agent's mail waits behind a failed turn, queued with the person's own follow-ups, until
// the chat continues: Resume, the person's own send, or the automatic continue at a usage-limit reset.
let rig: QueuedMessageTestRig

afterEach(() => rig.dispose())

const AGENT: AgentMessageSource = { kind: 'agent', senders: [], orchestration: null }

async function held(): Promise<boolean> {
  return (await rig.host.conversation(SESSION)).journal.queuedMessages.failureHolds()
}

async function appendTurn(name: string, outcome: 'success' | 'failure'): Promise<void> {
  const journal = (await rig.host.conversation(SESSION)).journal
  await journal.appendItem(
    { provider: 'orca', clientMessageId: `turn-${name}` },
    {
      kind: 'turn',
      turnId: name,
      providerTurnId: name,
      state: 'completed',
      outcome,
      startedAt: HOST_TEST_NOW,
      completedAt: HOST_TEST_NOW
    },
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
}

/** Another agent's message, sent as the mailbox sends one; resolves to its queued card's id. */
async function mail(text: string): Promise<string> {
  const result = await rig.send(text, 'queue-if-active', { internal: true, from: AGENT }).result
  if (!result.ok || !('queued' in result.value)) {
    throw new Error(`expected mail to queue, got ${JSON.stringify(result)}`)
  }
  return result.value.queued.messageId
}

/** The chat publishes the card as held behind the failed turn, and nothing has handed it over. */
async function stillWaiting(card: string): Promise<void> {
  expect(await rig.queuePause()).toEqual({ reason: 'failed' })
  expect(await rig.drafts()).toEqual([{ messageId: card, state: 'waiting' }])
  expect(await rig.handoff(card)).toBeUndefined()
}

async function failedChat(): Promise<void> {
  const working = await rig.workingSend()
  await rig.settleAccepted(working, 'working')
  await openRigTurnFor(rig, working)
  await openRigTurnFor(rig, working, 'completed', 'failure')
}

describe("a chat's hold on another agent's mail", () => {
  it('holds it once the last turn failed, until a newer turn runs', async () => {
    rig = await createQueuedMessageTestRig()
    expect(await held()).toBe(false)
    await appendTurn('finished', 'success')
    expect(await held()).toBe(false)
    await appendTurn('network-error', 'failure')
    expect(await held()).toBe(true)
    await appendTurn('recovered', 'success')
    expect(await held()).toBe(false)
  })

  it('queues mail after a failed turn and runs it as the next turn on Resume', async () => {
    rig = await createQueuedMessageTestRig()
    await failedChat()
    const card = await mail('update the install docs')
    await stillWaiting(card)
    expect(await rig.resume()).toMatchObject({ ok: true, value: { resumed: true } })
    await eventually(async () => expect((await rig.handoff(card))?.handedOverAt).toBeDefined())
  })

  it("runs queued mail after the person's own send recovers the chat", async () => {
    rig = await createQueuedMessageTestRig()
    await failedChat()
    const card = await mail('update the install docs')
    await stillWaiting(card)
    const person = rig.send('try again')
    expect(await person.result).toMatchObject({ ok: true })
    await eventually(async () =>
      expect((await rig.submission(person.id))?.handedOverAt).toBeDefined()
    )
    await rig.settleAccepted(person.id, 'person')
    await openRigTurnFor(rig, person.id, 'completed', 'success')
    await eventually(async () => expect((await rig.handoff(card))?.handedOverAt).toBeDefined())
  })

  it('runs queued mail once the automatic continue at a usage-limit reset succeeds', async () => {
    let clock = HOST_TEST_NOW
    rig = await createQueuedMessageTestRig({
      now: () => clock,
      usageLimitAutoContinue: {
        isEnabled: () => true,
        isWorkspaceAsleep: () => false,
        subscribe: () => () => {}
      }
    })
    const current = rig
    // Agent chats run without a tab.
    await current.store.setSessionTabVisibility(SESSION, false, undefined, { background: true })
    const journal = current.host.collaboratorsForTests().sessions.get(SESSION)!.journal
    const cut = await appendRewindUsageLimitedTurn(journal, clock)
    const card = await mail('update the install docs')
    await stillWaiting(card)
    clock = cut.resetsAt + 15_000
    await current.host.usageLimitContinue.tick()
    let continuation: string | undefined
    await eventually(async () => {
      continuation = (await readTestHostJournal(current.host, SESSION)).submissions.find(
        (submission) => submission.origin === 'host' && submission.handedOverAt !== undefined
      )?.clientMessageId
      expect(continuation).toBeDefined()
    })
    expect(await current.handoff(card)).toBeUndefined()
    await current.settleAccepted(continuation!, 'continued')
    await openRigTurnFor(current, continuation!, 'completed', 'success')
    await eventually(async () => expect((await current.handoff(card))?.handedOverAt).toBeDefined())
  })
})
