// A queued card when the agent ahead of it exits: every frame from the exit on reads the dead
// generation as ended (not Working, none of its prompts answerable), and the card is sent at once,
// whether the exit's release write lands, waits or keeps failing: an acquisition then replaces the
// owner once it is proven dead, and never one that is alive or unproven.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionOwnerProbe } from '../../../shared/agent-session-lease-adjudication'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../shared/agent-session-record.test-fixture'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession
} from '../../../shared/structured-agent-session-reducer'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'
import {
  exitChild,
  leaveUnfinishedWork
} from './structured-agent-session-leftover-settlement.test-fixture'
import {
  createQueuedMessageTestRig,
  eventually,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data'
import { isResumableStructuredAgentSessionRecord } from './structured-agent-session-resume-eligibility'

let rig: QueuedMessageTestRig | undefined

afterEach(async () => {
  await rig?.dispose()
  rig = undefined
  vi.restoreAllMocks()
})

/** A card queued behind a running turn that raised a prompt. */
async function queuedBehindPrompt(
  probeOwner?: StructuredAgentSessionHostDeps['probeOwner']
): Promise<{ current: QueuedMessageTestRig; draftId: string }> {
  rig = await createQueuedMessageTestRig({
    restartable: true,
    ...(probeOwner ? { probeOwner } : {})
  })
  const current = rig
  await current.workingSend()
  await leaveUnfinishedWork(current, { prompt: true })
  const queued = await current.send('after this', 'queue-if-active').result
  if (!queued.ok || !('queued' in queued.value)) {
    throw new Error('expected a queued receipt')
  }
  return { current, draftId: queued.value.queued.messageId }
}

/** Every release write refused, as storage that keeps failing would. */
function refuseReleases(current: QueuedMessageTestRig): () => number {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const transition = current.store.transitionHandoff.bind(current.store)
  let refused = 0
  vi.spyOn(current.store, 'transitionHandoff').mockImplementation((sessionId, change, options) =>
    transition(
      sessionId,
      (record) => {
        const next = change(record)
        if (next.lease.claimStatus === 'released') {
          refused += 1
          throw new Error('disk full')
        }
        return next
      },
      options
    )
  )
  return () => refused
}

/** What a client reads after each frame, from the host's own fields. */
async function watchChat(current: QueuedMessageTestRig) {
  let state = EMPTY_STRUCTURED_AGENT_SESSION
  const reads: { working: boolean; settled: boolean; prompts: number; cardSent: boolean }[] = []
  await current.host.subscribe({
    id: 'chat',
    sessionId: SESSION,
    emit: (event) => {
      state = reduceStructuredAgentSession(state, { type: 'event', event })
      reads.push({
        working: state.working === true,
        settled: state.latestTurn?.turn.state !== 'running',
        prompts: state.actionablePromptIds?.length ?? 0,
        cardSent: state.submissions.some((entry) => entry.queuedMessageId !== undefined)
      })
    }
  })
  return reads
}

const provenDead: StructuredAgentSessionHostDeps['probeOwner'] = async () => ({
  outcome: 'pid-absent'
})

describe('an exit whose settlement lands while its release keeps failing', () => {
  it('reads the dead generation as ended in every frame, and the card is sent over the proven-dead owner', async () => {
    const { current, draftId } = await queuedBehindPrompt(provenDead)
    const refused = refuseReleases(current)
    const reads = await watchChat(current)
    const before = reads.length

    await exitChild(current)
    await eventually(async () => expect(await current.handoff(draftId)).toBeDefined())
    await eventually(() => expect(current.dispatch).toHaveBeenCalledTimes(2))

    expect(refused()).toBeGreaterThan(0)
    const untilSent = reads.slice(before).filter((read) => !read.cardSent)
    expect(untilSent.length).toBeGreaterThan(0)
    // Not Working, and the dead generation's prompt answerable, in no frame before the card's send.
    expect(untilSent.filter((read) => read.working)).toEqual([])
    expect(untilSent.filter((read) => read.prompts > 0)).toEqual([])
    // Its turn was settled before the send, and the lease belongs to the generation that took it.
    expect(untilSent.at(-1)?.settled).toBe(true)
    expect(current.store.getRecord(SESSION)?.lease.claimStatus).toBe('live')
  })
})

describe('an exit that settles and releases cleanly', () => {
  it('sends the card with no added delay', async () => {
    const { current, draftId } = await queuedBehindPrompt()
    const started = Date.now()

    await exitChild(current)
    await current.host.collaboratorsForTests().serialize(SESSION, async () => {})
    await eventually(async () => expect(await current.handoff(draftId)).toBeDefined())

    // Inside one turn of the chat's lane: no retry round, no backoff.
    expect(Date.now() - started).toBeLessThan(250)
    expect(current.host.collaboratorsForTests().reconciliation.owes(SESSION)).toBe(false)
  })
})

describe('an owner this host cannot prove dead', () => {
  it.each([
    ['alive', { outcome: 'identity-matched', matchedOn: ['process-start-time'] }],
    ['unproven', { outcome: 'indeterminate', reason: 'no start time' }]
  ] satisfies [string, AgentSessionOwnerProbe][])(
    'is never replaced when %s: no agent starts over it, and the card comes back',
    async (_name, probe) => {
      const { current, draftId } = await queuedBehindPrompt(async () => probe)
      refuseReleases(current)
      const owner = current.store.getRecord(SESSION)?.lease

      await exitChild(current)
      await eventually(async () =>
        expect((await current.handoff(draftId))?.dispatchState).toBe('rejected')
      )

      expect(current.dispatch).toHaveBeenCalledTimes(1)
      expect(current.store.getRecord(SESSION)?.lease).toMatchObject({
        claimStatus: 'live',
        runtimeFence: owner?.runtimeFence,
        ownerProcess: owner?.ownerProcess
      })
      expect(await current.drafts()).toEqual([{ messageId: draftId, state: 'returned' }])
    }
  )

  it('widens nothing for a lease this host never saw end: another fence, or no root proof', () => {
    const record = agentSessionRecordFixture(
      agentSessionLeaseFixture({ claimStatus: 'live', handoffStage: null, runtimeFence: 7 })
    )
    expect(isResumableStructuredAgentSessionRecord(record)).toBe(false)
    expect(isResumableStructuredAgentSessionRecord(record, { fence: 6, rootGone: true })).toBe(
      false
    )
    expect(isResumableStructuredAgentSessionRecord(record, { fence: 7, rootGone: false })).toBe(
      false
    )
    expect(isResumableStructuredAgentSessionRecord(record, { fence: 7, rootGone: true })).toBe(true)
  })
})
