// A message handed to an agent whose start never answers provably never ran: its CLI takes no
// message before it answers initialize. So when the chat ends then, the message is settled as a
// queued one is for the same end (`journal-unsent-send-hold.ts`): a quit or a close keeps a
// person's words as a held card, a person's Stop withdraws it. Against the real host, store and
// journal, with an agent that stays starting.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { QUEUED_MESSAGE_PAUSED_KEPT } from '../../../shared/agent-session-queued-message-wire'
import {
  createQueuedMessageTestRig,
  eventually,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data'

const words = (kind: 'hostRestarted' | 'chatClosed' | 'cancelled') =>
  agentSessionFailureWords(agentSessionFailureFact(kind), { surface: 'rejection' })
const KEPT = { state: 'waiting', paused: true }

let rig: QueuedMessageTestRig

beforeEach(async () => {
  rig = await createQueuedMessageTestRig({
    restartable: true,
    starting: true,
    startUnanswered: true,
    stopEndsSession: true,
    recoveryCapsule: true
  })
})

afterEach(async () => {
  await rig.dispose()
})

/** Sent to the starting agent and handed over to it, never echoed. */
async function handedToHungStart(text: string): Promise<string> {
  // No child, so this send starts one that never answers.
  await rig.host.close(SESSION, 'evict')
  const sent = rig.send(text)
  await sent.result
  await eventually(async () => expect((await rig.submission(sent.id))?.handedOverAt).toBeDefined())
  expect(rig.host.collaboratorsForTests().sessions.get(SESSION)?.child?.phase).toBe('starting')
  return sent.id
}

describe('a message handed to a start that never answered, then the chat ends', () => {
  it('is a held card after a quit, rejected as a restart, as a queued one is', async () => {
    const id = await handedToHungStart('kept through quit')
    await rig.quitRestartHostProcess()

    expect(await rig.submission(id)).toMatchObject({
      dispatchState: 'rejected',
      ...words('hostRestarted'),
      keptAsQueuedMessageId: id
    })
    expect(await rig.drafts()).toEqual([{ messageId: id, ...KEPT }])
    const [card] =
      rig.host.collaboratorsForTests().sessions.get(SESSION)?.journal.queuedMessages.list() ?? []
    expect(card).toMatchObject({ holdReason: QUEUED_MESSAGE_PAUSED_KEPT })
    // Nothing ran, so there is nothing to resume: the card alone holds the words.
    expect(await rig.restartOffers()).toEqual([])
  })

  it('is offered for resume after a quit once the start answered, as the control', async () => {
    await rig.dispose()
    rig = await createQueuedMessageTestRig({
      restartable: true,
      starting: true,
      stopEndsSession: true,
      recoveryCapsule: true
    })
    const id = await handedToHungStart('may have run')
    await rig.quitRestartHostProcess()

    expect(await rig.restartOffers()).toEqual([
      { sessionId: SESSION, work: { kind: 'submission', id } }
    ])
  })

  it.each(['user-close', 'evict'] as const)(
    'is a held card after a %s, rejected as closed, as a queued one is',
    async (cause) => {
      const id = await handedToHungStart('kept at close')
      await rig.host.close(SESSION, cause)
      rig.crashRestartHostProcess()

      expect(await rig.submission(id)).toMatchObject({
        dispatchState: 'rejected',
        ...words('chatClosed'),
        keptAsQueuedMessageId: id
      })
      expect(await rig.drafts()).toEqual([{ messageId: id, ...KEPT }])
    }
  )

  it("is withdrawn by a person's Stop, as a queued one is, and kept as no card", async () => {
    const id = await handedToHungStart('stopped')

    expect(await rig.stop()).toMatchObject({ ok: true, value: { cancelled: true } })

    await eventually(async () =>
      expect(await rig.submission(id)).toMatchObject({
        dispatchState: 'rejected',
        ...words('cancelled')
      })
    )
    expect(await rig.drafts()).toEqual([])
  })
})
