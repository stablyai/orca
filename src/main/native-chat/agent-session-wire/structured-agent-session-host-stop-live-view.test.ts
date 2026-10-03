// A host stop (a close, an eviction, the host stopping a start) decides whether it ends work from
// the host's live view in its own serialized step, with no wait: the provider child's own report of
// what it has in flight, and the sends the journal holds unanswered. The journal's turn rows trail
// the child's frames, so they never decide it alone.

import { afterEach, describe, expect, it } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import type { JournalStopEvent } from '../agent-session-journal/journal-row-schema'
import { HOST_TEST_SESSION } from './structured-agent-session-host-test-data'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'

let rig: QueuedMessageTestRig

afterEach(() => rig.dispose())

type HostStopKind = 'user-close' | 'evict' | 'host-stop'

const KINDS: HostStopKind[] = ['user-close', 'evict', 'host-stop']

/** A rig whose provider reports its child's work, and the host stop of `kind` on it. The host stops
 *  a start that never landed from the idle sweep, so that rig's children all stay starting. */
async function rigFor(kind: HostStopKind): Promise<() => Promise<void>> {
  if (kind === 'host-stop') {
    rig = await createQueuedMessageTestRig({
      liveView: true,
      starting: true,
      restartable: true,
      idleSweep: { idleMs: 0, intervalMs: 60 * 60 * 1000 }
    })
    return () => rig.host.collaboratorsForTests().lifetime.idleSweep.tick()
  }
  rig = await createQueuedMessageTestRig({ liveView: true })
  return () => rig.host.close(HOST_TEST_SESSION, kind)
}

function journal() {
  const open = rig.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)?.journal
  if (!open) {
    throw new Error('expected the conversation open')
  }
  return open
}

function stopEvents(): JournalStopEvent[] {
  const since = journal().readSince({ epoch: journal().epoch, sequence: 0 })
  if (!since.ok) {
    throw new Error(`expected rows, got reset ${since.reset}`)
  }
  return since.rows.flatMap((row) =>
    row.kind === 'tombstone' && row.stopEvent ? [row.stopEvent] : []
  )
}

/** The Stop events as the provider's close finds them, or null when no close ran. */
function stopEventsAtClose(): { events: JournalStopEvent[] | null } {
  const seen: { events: JournalStopEvent[] | null } = { events: null }
  rig.closeSession.mockImplementationOnce(async () => {
    seen.events = stopEvents()
    return true
  })
  return seen
}

/** A send the provider accepted, with its turn's running row in the journal or still on its way. */
async function acceptedSend(turnRow: boolean): Promise<string> {
  const sent = await rig.workingSend()
  await rig.settleAccepted(sent, 'turn-1')
  if (turnRow) {
    await journal().appendItem(
      { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal: 999 },
      {
        kind: 'turn',
        turnId: 'turn-1',
        state: 'running',
        startedAt: 1,
        userItemId: agentJournalSubmissionKey(sent)
      },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  }
  return sent
}

describe.each(KINDS)('a host stop (%s) decides from the live view, with no wait', (kind) => {
  it('writes its event, naming the turn, for a turn the provider reports running', async () => {
    const hostStop = await rigFor(kind)
    await acceptedSend(true)
    rig.liveWork.mockReturnValue({ turnId: 'turn-1' })
    const atClose = stopEventsAtClose()

    await hostStop()

    expect(atClose.events).toEqual([{ reason: kind, turnId: 'turn-1', at: expect.any(Number) }])
  })

  // The acceptance lands straight in the journal; the turn row trails it through the sink.
  it('writes its event, naming the turn, for a turn opened whose row has not landed', async () => {
    const hostStop = await rigFor(kind)
    await acceptedSend(false)
    expect(journal().activeTurnId()).toBeNull()
    rig.liveWork.mockReturnValue({ turnId: 'turn-1' })
    const atClose = stopEventsAtClose()

    await hostStop()

    expect(atClose.events).toEqual([{ reason: kind, turnId: 'turn-1', at: expect.any(Number) }])
  })

  // Codex answered the send into a turn it has not opened yet.
  it('writes its event, naming no turn, for an accepted send whose turn has not opened', async () => {
    const hostStop = await rigFor(kind)
    await acceptedSend(false)
    rig.liveWork.mockReturnValue({ turnId: null })
    const atClose = stopEventsAtClose()

    await hostStop()

    expect(atClose.events).toEqual([{ reason: kind, at: expect.any(Number) }])
  })

  // The provider ended the turn; its end row trails through the sink, so the journal still reads
  // it running. Nothing is in flight, so this stop ends nothing.
  it("writes nothing at rest, while the turn's end row is still on its way", async () => {
    const hostStop = await rigFor(kind)
    await acceptedSend(true)
    expect(journal().activeTurnId()).toBe('turn-1')
    const atClose = stopEventsAtClose()

    await hostStop()

    expect(rig.liveWork).toHaveBeenCalled()
    expect(atClose.events).toEqual([])
  })

  it('writes nothing at rest', async () => {
    const hostStop = await rigFor(kind)
    const atClose = stopEventsAtClose()

    await hostStop()

    expect(atClose.events).toEqual([])
  })

  // A send whose reply was lost may still run: loss of contact is no proof it ended.
  it('writes its event for a send still unanswered, whatever the provider reports', async () => {
    const hostStop = await rigFor(kind)
    await rig.workingSend()
    const atClose = stopEventsAtClose()

    await hostStop()

    expect(atClose.events).toEqual([{ reason: kind, at: expect.any(Number) }])
  })
})

// A person's own close always writes: it is theirs. Any other host stop keeps their Stop's reason.
// A person's Stop of a start ends that child, so the host stops only a later start, which a send
// after the Stop made.
describe.each(['user-close', 'evict'] as const)(
  "a person's Stop holds against a later close (%s)",
  (kind) => {
    const later = kind === 'user-close' ? ['user-stop', kind] : ['user-stop']

    it('of the turn it named, still winding down', async () => {
      const hostStop = await rigFor(kind)
      await acceptedSend(true)
      rig.liveWork.mockReturnValue({ turnId: 'turn-1' })
      expect(await rig.stop()).toMatchObject({ ok: true })
      expect(stopEvents()).toEqual([expect.objectContaining({ turnId: 'turn-1' })])
      const atClose = stopEventsAtClose()

      await hostStop()

      expect(atClose.events?.map((event) => event.reason)).toEqual(later)
    })

    // Pressed before the turn opened; the send it stopped is then accepted, its turn row still on
    // its way: the work in flight is still the Stop's.
    it('naming no turn, over the send it stopped whose turn row has not landed', async () => {
      const hostStop = await rigFor(kind)
      const sent = await rig.workingSend()
      rig.liveWork.mockReturnValue({ turnId: 'turn-1' })
      expect(await rig.stop()).toMatchObject({ ok: true })
      expect(stopEvents()).toEqual([expect.not.objectContaining({ turnId: expect.anything() })])
      await rig.settleAccepted(sent, 'turn-1')
      expect(journal().activeTurnId()).toBeNull()
      const atClose = stopEventsAtClose()

      await hostStop()

      expect(atClose.events?.map((event) => event.reason)).toEqual(later)
    })
  }
)

describe.each(KINDS)("a person's Stop does not hold a later host stop (%s)", (kind) => {
  it('over a send made after it', async () => {
    const hostStop = await rigFor(kind)
    const stopped = await rig.workingSend()
    expect(await rig.stop()).toMatchObject({ ok: true })
    await rig.settleAccepted(stopped, 'stopped')
    const after = await rig.workingSend()
    await rig.settleAccepted(after, 'turn-2')
    rig.liveWork.mockReturnValue({ turnId: 'turn-2' })
    const atClose = stopEventsAtClose()

    await hostStop()

    expect(atClose.events?.map((event) => event.reason)).toEqual(['user-stop', kind])
  })
})
