import { JournalSqlOwner } from '../agent-session-journal/journal-sql-owner'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession
} from '../../../shared/agent-session/structured-agent-session-reducer'
import {
  leaveUnfinishedWork,
  exitChild
} from './structured-agent-session-leftover-settlement.test-fixture'
import { afterEach, expect, it, vi } from 'vitest'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'
import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { HOST_TEST_SESSION as id } from './structured-agent-session-host-test-data'

let rig: QueuedMessageTestRig | undefined
const journals = createTrackedJournalOpener()
afterEach(async () => {
  vi.restoreAllMocks()
  await journals.closeAll()
  await rig?.dispose()
})

it('retires an obsolete replacement notification without overwriting or notifying its successor', async () => {
  const failures = vi.fn()
  rig = await createQueuedMessageTestRig({ onRequestFailure: failures })
  await rig.workingSend()
  const sessions = rig.host.collaboratorsForTests().sessions
  const previous = sessions.get(id)!
  const journal = previous.journal
  const successor = await journals.open({
    identity: {
      sessionId: id,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: codexProviderHandle('successor')
    },
    stateDirectory: `${rig.root}/successor`
  })
  await successor.appendItem(
    { provider: 'orca', clientMessageId: 'successor' },
    { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Successor prompt' }] },
    { fence: 1, turnScope: { kind: 'thread' } }
  )
  const hints: string[] = []
  const release = sessions.observeConversationPublications(id, {
    next: (hint) => {
      hints.push(hint.kind)
    },
    error: (error) => {
      throw error
    }
  })
  const changed = Promise.withResolvers<void>()
  const steps = journal.statusReadSteps.bind(journal)
  vi.spyOn(journal, 'statusReadSteps').mockImplementationOnce(function* () {
    setImmediate(() => {
      sessions.delete(id)
      sessions.set(id, { ...previous, journal: successor })
      rig!.host['clientDelivery'].publishRestored(id)
      changed.resolve()
    })
    return yield* steps()
  })
  const items = Array.from({ length: 512 }, (_, index) => ({
    identity: { provider: 'orca' as const, clientMessageId: `replacement-${index}` },
    body: {
      kind: 'message' as const,
      role: 'user' as const,
      blocks: [{ type: 'text' as const, text: `old lifetime ${index}` }]
    },
    ownerFence: 1
  }))
  try {
    await journal.replaceEpochItems('handle_forked', 1, items)
    await changed.promise
    expect(hints).toContain('detach')
    expect(hints).not.toContain('commit')
    expect(failures).not.toHaveBeenCalled()
    expect(rig.host['clientDelivery'].readStatusSummary(id)?.latestPrompt).toBe('Successor prompt')
    expect(journal.snapshot().items).toHaveLength(512)
    expect(successor.snapshot().items).toHaveLength(1)
    const reopened = await journals.open({
      identity: {
        sessionId: id,
        workspaceId: 'workspace-1',
        hostId: 'local',
        agent: 'codex',
        providerHandle: codexProviderHandle('successor')
      },
      stateDirectory: `${rig.root}/successor`
    })
    expect(reopened.snapshot()).toEqual(successor.snapshot())
  } finally {
    release()
  }
})

it('finishes finite status preparation when a best-effort request observer fails', async () => {
  rig = await createQueuedMessageTestRig()
  await rig.workingSend()
  const client = rig.host['clientDelivery']
  const journal = rig.host.collaboratorsForTests().sessions.get(id)!.journal
  vi.spyOn(client.requestFailures, 'observeAsync').mockRejectedValueOnce(
    new Error('observer failed')
  )
  const status = vi.spyOn(journal, 'statusRead')
  const prepared = vi.spyOn(journal, 'statusReadSteps')
  await journal.replaceEpochItems('handle_forked', 1, [
    {
      identity: { provider: 'orca', clientMessageId: 'replacement' },
      body: {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: 'Replacement prompt' }]
      },
      ownerFence: 1
    }
  ])
  expect(prepared).toHaveBeenCalled()
  expect(status).not.toHaveBeenCalled()
  expect(client.readStatusSummary(id)?.latestPrompt).toBe('Replacement prompt')
  expect(journal.snapshot().items).toHaveLength(1)
})

async function holdOrdinaryWrite(current: QueuedMessageTestRig) {
  const journal = current.host.collaboratorsForTests().sessions.get(id)!.journal
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const request = JournalSqlOwner.prototype.request
  let held = false
  const spy = vi.spyOn(JournalSqlOwner.prototype, 'request').mockImplementation(async function (
    this: JournalSqlOwner,
    command
  ) {
    const response = request.call(this, command)
    if (command.type === 'unit' && !held) {
      held = true
      entered.resolve()
      await release.promise
    }
    return response
  })
  let finished = false
  const write = journal
    .appendItem(
      { provider: 'orca', clientMessageId: 'in-flight' },
      { kind: 'status', text: 'ordinary write' },
      { fence: 1, turnScope: { kind: 'thread' } }
    )
    .finally(() => {
      finished = true
    })
  await entered.promise
  spy.mockRestore()
  return { journal, write, release: release.resolve, finished: () => finished }
}

it('publishes a settled Stop before an ordinary native write completes', async () => {
  rig = await createQueuedMessageTestRig()
  await rig.workingSend()
  await leaveUnfinishedWork(rig)
  const client = rig.host['clientDelivery']
  const journal = rig.host.collaboratorsForTests().sessions.get(id)!.journal
  await journal.appendStopEvent({ reason: 'user-stop' }, 1)
  const settle = journal.stopMarks.beginSettle(true)
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(client.readStatusSummary(id)).toMatchObject({ status: 'working', stopping: true })
  const busy = await holdOrdinaryWrite(rig)
  try {
    journal.stopMarks.settled(settle)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(busy.finished()).toBe(false)
    expect(client.readStatusSummary(id)?.stopping).toBeUndefined()
    expect(client.readStatusSummary(id)?.status).toBe('working')
  } finally {
    busy.release()
    await busy.write
  }
})

it.each([false, true])(
  'publishes process death before an ordinary write drains (closing=%s)',
  async (closing) => {
    rig = await createQueuedMessageTestRig()
    await rig.workingSend()
    await leaveUnfinishedWork(rig, { prompt: true })
    let state = EMPTY_STRUCTURED_AGENT_SESSION
    const dead = Promise.withResolvers<void>()
    let expectingDeath = false
    const unsubscribe = await rig.host.subscribe({
      id: 'death-reader',
      sessionId: id,
      readsCurrentRequests: true,
      emit: (event) => {
        state = reduceStructuredAgentSession(state, { type: 'event', event })
        if (expectingDeath && state.working === false && state.actionablePromptIds?.length === 0) {
          dead.resolve()
        }
      }
    })
    expect(state.working).toBe(true)
    expect(state.actionablePromptIds).toHaveLength(1)
    const busy = await holdOrdinaryWrite(rig)
    const observed = vi.spyOn(rig.host['clientDelivery'].requestFailures, 'generationEnded')
    let closed: Promise<void> | undefined
    if (closing) {
      closed = busy.journal.close()
    }
    expectingDeath = true
    const dying = exitChild(rig)
    try {
      await dead.promise
      expect(busy.finished()).toBe(false)
      expect(observed).toHaveBeenCalledWith(id)
      expect(rig.host['clientDelivery'].readStatusSummary(id)?.status).toBe('idle')
      expect(state.actionablePromptIds).toEqual([])
    } finally {
      busy.release()
      await busy.write
      await dying
      await closed
      unsubscribe()
    }
  }
)
