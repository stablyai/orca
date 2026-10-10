// A person's Stop on a ready, idle agent, landing between a send's accept and its handover: the
// send comes back as a card, and every frame clients are published shows it under the Stop's
// pause, never as the next card to send. Against the real host, store and journal.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { holdDelivery } from './structured-agent-session-delivery-hold.test-fixture'
import {
  structuredQueueSendGate,
  tryReadQueuePublication
} from './structured-agent-session-queued-publication'
import {
  createQueuedMessageTestRig,
  eventually,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data'

type Frame = { cards: string[]; pause: string | null; next: string | null }

let rig: QueuedMessageTestRig

beforeEach(async () => {
  rig = await createQueuedMessageTestRig({ restartable: true })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rig.dispose()
})

function journal(): AgentSessionJournal {
  const open = rig.host.collaboratorsForTests().sessions.get(SESSION)?.journal
  if (!open) {
    throw new Error('the conversation is not open')
  }
  return open
}

/** A send the delivery loop holds before its handover, on an agent that is ready and idle. */
async function sendHeldOnIdleAgent(): Promise<{ id: string; release: () => void }> {
  const working = await rig.workingSend()
  await rig.settleAccepted(working, 'working')
  await eventually(() => expect(journal().activeTurnId()).toBeNull())
  const hold = holdDelivery()
  const typed = rig.send('typed then stopped')
  await typed.result
  await hold.held
  return { id: typed.id, release: hold.release }
}

/** Every queue publication clients are sent from now on. */
function recordFrames(): Frame[] {
  const frames: Frame[] = []
  const { subscribers } = rig.host.collaboratorsForTests()
  const publish = subscribers.publish.bind(subscribers)
  vi.spyOn(subscribers, 'publish').mockImplementation((sessionId, published, activity) => {
    const queue = tryReadQueuePublication(published, structuredQueueSendGate(rig.store, SESSION))
    frames.push({
      cards: (queue?.queuedMessages ?? []).map((card) => card.messageId),
      pause: queue?.queuePause?.reason ?? null,
      next: queue?.nextQueuedMessageId ?? null
    })
    publish(sessionId, published, activity)
  })
  return frames
}

it('publishes the kept card only under the Stop pause', async () => {
  const typed = await sendHeldOnIdleAgent()
  const dispatches = rig.dispatch.mock.calls.length
  const frames = recordFrames()

  const stopped = rig.stop()
  typed.release()
  expect(await stopped).toMatchObject({ ok: true, value: { cancelled: true } })

  const withCard = frames.filter((frame) => frame.cards.includes(typed.id))
  expect(withCard.length).toBeGreaterThan(0)
  for (const frame of withCard) {
    expect(frame).toMatchObject({ pause: 'stopped', next: null })
  }
  expect(await rig.drafts()).toEqual([{ messageId: typed.id, state: 'waiting' }])
  expect(rig.dispatch.mock.calls.length).toBe(dispatches)
})

// A rare storage failure, accepted: with no Stop recorded nothing pauses the queue, so the kept
// card sends as any card would, once.
it("sends the kept card once when the Stop's own record fails to save", async () => {
  const typed = await sendHeldOnIdleAgent()
  const dispatches = rig.dispatch.mock.calls.length
  vi.spyOn(journal(), 'appendStopEvent').mockRejectedValue(new Error('disk full'))

  const stopped = rig.stop()
  typed.release()
  expect(await stopped).toMatchObject({ ok: true, value: { cancelled: true } })

  await eventually(async () => {
    expect(await rig.drafts()).toEqual([])
    expect(rig.dispatch.mock.calls.length).toBe(dispatches + 1)
  })
  expect(await rig.queuePause()).toBeNull()
  expect((await rig.submission(typed.id))?.keptAsQueuedMessageId).toBe(typed.id)
})
