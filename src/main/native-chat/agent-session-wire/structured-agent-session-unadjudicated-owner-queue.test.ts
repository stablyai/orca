// After a restart, an owner no adjudication has concluded about (unreconciled: its probe failed;
// recovering: proven alive, same runtime) on a chat no tab shows. Every host reader reads its
// leftover turn as the chat shows it: unverifiable, not working. The earlier process's card waits
// under the restart's pause; a person's own send goes to a start, which decides the owner.

import { afterEach, expect, it, vi } from 'vitest'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import {
  createQueuedMessageTestRig,
  QUEUED_RIG_CALLER as CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  currentJournal,
  leaveUnfinishedWork,
  sendText
} from './structured-agent-session-leftover-settlement.test-fixture'
import { structuredQueuePauses } from './structured-agent-session-queued-pause'
import { setStructuredAgentSessionHost } from './structured-agent-session-registry'
import { readStructuredSessionGateFacts } from '../../runtime/orchestration/structured-mailbox-pointer-host'
import { structuredWorkerAgentStatus } from '../../runtime/orchestration/structured-worker-group-addressing'

const MODES = ['unreconciled', 'recovering'] as const

let rig: QueuedMessageTestRig | undefined

afterEach(async () => {
  setStructuredAgentSessionHost(null)
  await rig?.dispose()
  rig = undefined
  vi.restoreAllMocks()
})

/** The chat reopened in a new process with its owner undecided; `earlier` is a card the earlier
 *  process queued while it worked. Answers the owner-stop spy and the probe's call count. */
async function reopened(
  mode: (typeof MODES)[number],
  options: { leftoverTurn: boolean; earlier?: 'message' | 'compact' }
) {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const probes = { calls: 0 }
  rig = await createQueuedMessageTestRig({
    restartable: true,
    probeOwner: async () => {
      probes.calls += 1
      if (mode === 'unreconciled') {
        throw new Error('the probe could not run')
      }
      return { outcome: 'identity-matched', matchedOn: ['process-start-time'] }
    }
  })
  const current = rig
  await current.workingSend()
  let earlierCard: string | undefined
  if (options.earlier === 'message') {
    const queued = await sendText(current, 'queued before the crash').result
    earlierCard = queued.ok && 'queued' in queued.value ? queued.value.queued.messageId : undefined
  } else if (options.earlier === 'compact') {
    earlierCard = await queueCompact(current)
  }
  if (options.leftoverTurn) {
    await leaveUnfinishedWork(current)
  }
  // No tab restore: nothing at startup decides the owner.
  await current.crashReloadHostProcess(() => undefined)
  await current.host.history({ sessionId: SESSION, direction: 'tail' })
  const stopOwnerProcess = vi.fn()
  current.host.deps.stopOwnerProcess = stopOwnerProcess
  const lease = current.store.getRecord(SESSION)?.lease
  expect(mode === 'unreconciled' ? lease?.unreconciled : lease?.handoffStage).toBe(
    mode === 'unreconciled' ? true : 'recovering'
  )
  return { current, stopOwnerProcess, probes, earlierCard }
}

async function queueCompact(current: QueuedMessageTestRig): Promise<string | undefined> {
  const fields = { command: 'compact' as const, delivery: 'queue-if-active' as const }
  const id = hostTestOperationId()
  const result = await current.host.conversationCommand(CALLER, {
    envelope: current.envelope(fields, 'agentSession.conversationCommand', id),
    ...fields,
    userSend: true
  })
  return result.ok && result.value.queued ? result.value.queued.messageId : undefined
}

async function page(current: QueuedMessageTestRig) {
  const read = await current.host.history({ sessionId: SESSION, direction: 'tail' })
  if (!read.ok) {
    throw new Error('history refused')
  }
  return read.page
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 3_000))

it.each(MODES)(
  "holds the earlier process's card under the restart's pause while the owner is %s: nothing sent or stopped",
  async (mode) => {
    const { current, stopOwnerProcess, earlierCard } = await reopened(mode, {
      leftoverTurn: true,
      earlier: 'message'
    })
    expect(earlierCard).toBeDefined()
    const starts = current.starts.length
    const dispatches = current.dispatch.mock.calls.length

    await settle()

    expect(structuredQueuePauses(currentJournal(current)).map((pause) => pause.reason)).toContain(
      'restarted'
    )
    const held = await page(current)
    expect(held.working).toBe(false)
    expect(held.nextQueuedMessageId ?? null).toBeNull()
    expect(held.queuedMessages?.map((card) => [card.messageId, card.state])).toEqual([
      [earlierCard, 'waiting']
    ])
    expect(current.starts.length).toBe(starts)
    expect(current.dispatch.mock.calls.length).toBe(dispatches)
    expect(stopOwnerProcess).not.toHaveBeenCalled()

    // The person's own send is no card the queue could send for them later: it goes to a start.
    const sent = await sendText(current, 'while it may still run').result
    expect(sent).toMatchObject({ ok: true, value: { submission: expect.anything() } })
    await settle()
    const after = await page(current)
    expect(after.queuedMessages?.map((card) => [card.messageId, card.state])).toEqual([
      [earlierCard, 'waiting']
    ])
    expect(after.queuedMessages?.[0]?.returnedReason).toBeUndefined()
    expect(await current.handoff(earlierCard ?? '')).toBeUndefined()
  },
  30_000
)

it.each(MODES.flatMap((mode) => [true, false].map((leftoverTurn) => ({ mode, leftoverTurn }))))(
  "sends a person's queue-if-active message to a start that decides the owner ($mode, leftover turn: $leftoverTurn)",
  async ({ mode, leftoverTurn }) => {
    const { current, stopOwnerProcess, probes } = await reopened(mode, { leftoverTurn })
    expect((await page(current)).working).toBe(false)
    const probed = probes.calls

    const sent = await sendText(current, 'while it may still run').result

    expect(sent).toMatchObject({ ok: true, value: { submission: expect.anything() } })
    expect(sent.ok && 'queued' in sent.value).toBe(false)
    await vi.waitFor(() => expect(probes.calls).toBeGreaterThan(probed), { timeout: 10_000 })
    expect((await page(current)).queuedMessages ?? []).toEqual([])
    // A recovery the start resolves ends the owner it proved alive, as on main; no proof, no stop.
    if (mode === 'recovering') {
      await vi.waitFor(() => expect(stopOwnerProcess).toHaveBeenCalledOnce(), { timeout: 10_000 })
    } else {
      expect(stopOwnerProcess).not.toHaveBeenCalled()
    }
  },
  30_000
)

it.each(MODES)(
  "sends a /compact card on Send while the chat shows the %s owner's turn as not working",
  async (mode) => {
    const { current, earlierCard } = await reopened(mode, {
      leftoverTurn: true,
      earlier: 'compact'
    })
    expect(earlierCard).toBeDefined()
    expect((await page(current)).working).toBe(false)

    const sent = await current.sendNow(earlierCard ?? '')

    expect(sent).toMatchObject({
      ok: true,
      value: { submission: { queuedMessageId: earlierCard } }
    })
  },
  30_000
)

it.each(MODES)(
  "reads the %s owner's leftover turn for @idle as the chat shows it",
  async (mode) => {
    const { current } = await reopened(mode, { leftoverTurn: true })
    setStructuredAgentSessionHost(current.host)
    const record = current.store.getRecord(SESSION)
    if (!record) {
      throw new Error('expected the record')
    }
    const { working } = await page(current)

    const facts = await readStructuredSessionGateFacts(SESSION)
    const status = await structuredWorkerAgentStatus({ sessionId: SESSION, record, lineage: [] })

    expect(working).toBe(false)
    expect(facts?.turnRunning).toBe(working)
    expect(status).toBe('idle')
  },
  30_000
)
