// A Stop pressed before its send's turn showed binds the turn that send opens only by stopping it:
// a Codex turn that did not open in time ends with the child the Stop ends, and a Claude turn that
// opens before the Stop's child end is proven ends as the Stop's. Nothing reads as running after.

import { afterEach, describe, expect, it } from 'vitest'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemIdentity
} from '../../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { isStructuredAgentSessionMainAgentWorking } from '../../../shared/structured-agent-session-main-agent-working'
import { HOST_TEST_SESSION } from './structured-agent-session-host-test-data'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'

let rig: QueuedMessageTestRig

afterEach(() => rig.dispose())

const LATER: AgentJournalItemIdentity = {
  provider: 'codex',
  threadId: 'thread-1',
  turnId: 'turn-later',
  ordinal: 1000
}

const OPENED: AgentJournalItemIdentity = {
  provider: 'codex',
  threadId: 'thread-1',
  turnId: 'turn-opened',
  ordinal: 999
}

function journal() {
  const open = rig.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)?.journal
  if (!open) {
    throw new Error('expected the conversation open')
  }
  return open
}

/** The turn `clientMessageId` opens, running, as the provider writes it. */
async function turnOpens(clientMessageId: string): Promise<void> {
  await journal().appendItem(
    OPENED,
    {
      kind: 'turn',
      turnId: 'turn-opened',
      state: 'running',
      startedAt: Date.now(),
      userItemId: agentJournalSubmissionKey(clientMessageId)
    },
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
}

function openedTurn() {
  return journal()
    .snapshot()
    .items.map((item) => readAgentJournalTurn(item.body))
    .find((turn) => turn?.turnId === 'turn-opened')
}

function nothingRuns(): boolean {
  return !isStructuredAgentSessionMainAgentWorking(
    journal().activeTurnId(),
    journal().submissions()
  )
}

/** Drains the Stop's next step on the session's lane: a wind-down it handed the child's end to. */
async function windDown(): Promise<void> {
  await rig.host['tasks'].serialize(HOST_TEST_SESSION, async () => {})
}

describe('a Codex Stop whose answered turn did not open in time', () => {
  // Codex admitted the send, answered into a turn it has not opened; the Stop's wait ran out.
  async function stopOfAnsweredSend(): Promise<string> {
    rig = await createQueuedMessageTestRig()
    const sent = await rig.workingSend()
    rig.cancelTurn.mockResolvedValueOnce({ cancelled: false, refusal: { turnMayOpen: true } })
    return sent
  }

  it('ends the child, so the turn can never run', async () => {
    await stopOfAnsweredSend()

    expect(await rig.stop()).toMatchObject({ ok: true, value: { cancelled: true } })

    expect(rig.closeSession).toHaveBeenCalled()
    expect(openedTurn()).toBeUndefined()
    expect(nothingRuns()).toBe(true)
  })

  it('reads a turn that opened before the child end as interrupted by the Stop', async () => {
    const sent = await stopOfAnsweredSend()
    rig.closeSession.mockImplementationOnce(async () => {
      await turnOpens(sent)
      return true
    })

    expect(await rig.stop()).toMatchObject({ ok: true, value: { cancelled: true } })

    expect(openedTurn()).toMatchObject({ state: 'interrupted', outcome: 'cancellation' })
    expect(nothingRuns()).toBe(true)
  })
})

describe('a Codex Stop that could not reach a turn still able to open, whose kill failed', () => {
  it('says the Stop is unconfirmed, never that no turn was running', async () => {
    rig = await createQueuedMessageTestRig()
    await rig.workingSend()
    rig.cancelTurn.mockResolvedValueOnce({ cancelled: false, refusal: { turnMayOpen: true } })
    rig.closeSession.mockRejectedValueOnce(new Error('the kill timed out'))

    expect(await rig.stop()).toMatchObject({ ok: true, value: { cancelled: false } })

    const rows = journal()
      .snapshot()
      .items.flatMap((item) => (item.body.kind === 'status' ? [item.body.failure?.kind] : []))
    expect(rows).toEqual(['cancelUnconfirmed'])
  })
})

describe('a Claude Stop pressed before its send echoed', () => {
  it('reads the turn that opens before its child end is proven as interrupted by the Stop', async () => {
    rig = await createQueuedMessageTestRig({ stopEndsSession: true })
    const sent = await rig.workingSend()
    rig.closeSession.mockImplementationOnce(async () => {
      await turnOpens(sent)
      return true
    })

    expect(await rig.stop()).toMatchObject({ ok: true, value: { cancelled: true } })
    await windDown()

    expect(rig.closeSession).toHaveBeenCalled()
    expect(openedTurn()).toMatchObject({ state: 'interrupted', outcome: 'cancellation' })
    expect(nothingRuns()).toBe(true)
  })
})

describe("a person's close pressed before its send's turn showed", () => {
  it('reads the turn its child end cut as interrupted by the person', async () => {
    rig = await createQueuedMessageTestRig()
    const sent = await rig.workingSend()
    rig.closeSession.mockImplementationOnce(async () => {
      await turnOpens(sent)
      return true
    })

    await rig.host.close(HOST_TEST_SESSION, 'user-close')

    const { items } = await rig.host.journalSnapshot(HOST_TEST_SESSION)
    const turn = items
      .map((item) => readAgentJournalTurn(item.body))
      .find((entry) => entry?.turnId === 'turn-opened')
    expect(turn).toMatchObject({ state: 'interrupted', outcome: 'cancellation' })
  })

  // A /clear stops the agent as the person's close and keeps the conversation, so the close's
  // settle must have closed by the time a later turn ends.
  it('binds no turn that ends on its own after a close the conversation outlived', async () => {
    rig = await createQueuedMessageTestRig()
    await rig.workingSend()
    await rig.host['lifetime'].stopAgent(HOST_TEST_SESSION, { cause: 'user-close' })
    expect(journal().stopMarks.latest()?.event).toMatchObject({ reason: 'user-close' })
    expect(journal().stopMarks.latest()?.event).not.toHaveProperty('turnId')

    await journal().appendItem(
      LATER,
      { kind: 'turn', turnId: 'turn-later', state: 'running', startedAt: Date.now() },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    await journal().appendItem(
      LATER,
      {
        kind: 'turn',
        turnId: 'turn-later',
        state: 'interrupted',
        startedAt: Date.now(),
        completedAt: Date.now() + 5
      },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )

    const later = journal()
      .snapshot()
      .items.map((item) => readAgentJournalTurn(item.body))
      .find((turn) => turn?.turnId === 'turn-later')
    expect(later).toMatchObject({ state: 'interrupted' })
    expect(later).not.toHaveProperty('outcome')
  })
})
