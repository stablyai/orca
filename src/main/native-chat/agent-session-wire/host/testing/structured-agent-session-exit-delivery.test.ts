import { afterEach, describe, expect, it, vi } from 'vitest'
import { withTestAgentSessionDatabase } from '../../../../runtime/agent-session/records/agent-session-record-store-test-harness'
import type { AgentSessionOwnerProbe } from '../../../../../shared/agent-session/lifecycle/leases/agent-session-lease-adjudication'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession
} from '../../../../../shared/agent-session/structured-agent-session-reducer'
import type { StructuredAgentSessionHostDeps } from '../structured-agent-session-host-types'
import {
  exitChild,
  leaveUnfinishedWork
} from './structured-agent-session-leftover-settlement.test-fixture'
import { createQueuedMessageTestRig } from './structured-agent-session-queued-message-rig.test-fixture'

import { eventually } from './structured-agent-session-queued-message-rig-provider.test-fixture'
import type { QueuedMessageTestRig } from './structured-agent-session-queued-message-rig.test-fixture'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data.test-fixture'
// Proven generation death must immediately disable old work and wake cards even when lease release fails.

let rig: QueuedMessageTestRig | undefined

afterEach(async () => {
  await rig?.dispose()
  rig = undefined
  vi.restoreAllMocks()
})

async function queuedBehindPrompt(
  probeOwner?: StructuredAgentSessionHostDeps['probeOwner']
): Promise<{ current: QueuedMessageTestRig; draftId: string }> {
  rig = await createQueuedMessageTestRig({
    restartable: true,
    ...(probeOwner ? { probeOwner } : {})
  })
  const current = rig
  await current.settleAccepted(await current.workingSend(), 'received')
  await leaveUnfinishedWork(current, { prompt: true })
  const queued = await current.send('after this', 'queue-if-active').result
  if (!queued.ok || !('queued' in queued.value)) {
    throw new Error('expected a queued receipt')
  }
  return { current, draftId: queued.value.queued.messageId }
}

async function refuseReleases(current: QueuedMessageTestRig): Promise<void> {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  await withTestAgentSessionDatabase(current.root, (db) =>
    db.exec(`
    CREATE TRIGGER reject_release BEFORE UPDATE OF record_json ON agent_session_records
    WHEN json_extract(NEW.record_json, '$.lease.claimStatus')='released'
    BEGIN SELECT RAISE(ABORT, 'disk full'); END
  `)
  )
}

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
  await eventually(() => expect(reads.length).toBeGreaterThan(0))
  return reads
}

const provenDead: StructuredAgentSessionHostDeps['probeOwner'] = async () => ({
  outcome: 'pid-absent'
})

describe('an exit whose settlement lands while its release keeps failing', () => {
  it('reads the dead generation as ended in every frame, and the card is sent over the proven-dead owner', async () => {
    const { current, draftId } = await queuedBehindPrompt(provenDead)
    await refuseReleases(current)
    const reads = await watchChat(current)
    const before = reads.length

    await exitChild(current)
    await eventually(async () => expect(await current.handoff(draftId)).toBeDefined())
    await eventually(() => expect(current.dispatch).toHaveBeenCalledTimes(2))

    const untilSent = reads.slice(before).filter((read) => !read.cardSent)
    expect(untilSent.length).toBeGreaterThan(0)
    expect(untilSent.filter((read) => read.working)).toEqual([])
    expect(untilSent.filter((read) => read.prompts > 0)).toEqual([])
    expect(untilSent.at(-1)?.settled).toBe(true)
    expect(current.store.getRecord(SESSION)?.lease.claimStatus).toBe('live')
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
      await refuseReleases(current)
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
})
