import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'
import { JournalQueuedMessages } from '../agent-session-journal/journal-queued-messages'
import { readStructuredAgentSessionHistoryResult } from './structured-agent-session-history-result'
import {
  readQueuePublication,
  structuredQueueSendGate
} from './structured-agent-session-queued-publication'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import { HOST_TEST_NOW, HOST_TEST_SESSION } from './structured-agent-session-host-test-data'

let rig: QueuedMessageTestRig
beforeEach(async () => {
  rig = await createQueuedMessageTestRig()
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rig.dispose()
})

it('keeps the complete legacy history reply byte-identical and replaces only its queue list after opt-in', async () => {
  await rig.workingSend()
  await rig.send('exact draft "\\🦦', 'queue-if-active').result
  const request = { sessionId: HOST_TEST_SESSION, direction: 'tail' as const }
  const session = rig.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)
  if (!session) {
    throw new Error('missing conversation')
  }
  const journal = session.journal
  const base = readStructuredAgentSessionHistoryResult({
    journal,
    record: rig.store.getRecord(HOST_TEST_SESSION),
    request
  })
  const queue = readQueuePublication(journal, structuredQueueSendGate(rig.store, HOST_TEST_SESSION))
  const expected = {
    ...base,
    page: {
      ...base.page,
      hostNow: HOST_TEST_NOW,
      queuedMessages: queue.queuedMessages,
      queuePause: queue.queuePause,
      nextQueuedMessageId: queue.nextQueuedMessageId,
      backgroundTasks: null
    }
  }
  expect(JSON.stringify(await rig.host.history(request))).toBe(JSON.stringify(expected))
  const list = vi.spyOn(JournalQueuedMessages.prototype, 'list')
  const paged = await rig.host.history({ ...request, queueView: 'paged-v1' })
  expect(paged.page).not.toHaveProperty('queuedMessages')
  expect(paged.page.queueSummary).toMatchObject({
    total: 1,
    counts: { person: 1, agent: 0, unknown: 0 }
  })
  expect(paged.page.queuePause).toEqual(queue.queuePause)
  expect(paged.page.nextQueuedMessageId).toEqual(queue.nextQueuedMessageId)
  expect(list).not.toHaveBeenCalled()
})

it('publishes host-derived Resume availability and off-page blockers on commit notifications', async () => {
  await rig.workingSend()
  await rig.send('queued', 'queue-if-active').result
  const frames: AgentSessionSubscribeEvent[] = []
  await rig.host.subscribe({
    id: 'paged',
    sessionId: HOST_TEST_SESSION,
    queueView: 'paged-v1',
    emit: (event) => frames.push(event)
  })
  await rig.stop()
  const history = await rig.host.history({
    sessionId: HOST_TEST_SESSION,
    direction: 'tail',
    queueView: 'paged-v1'
  })
  expect(history.page.queueSummary?.resumeAvailable).toBe(history.page.queuePause !== null)
  expect(history.page.queueSummary?.resumeAvailable).toBe(true)
  expect(history.page.queueSummary?.total).toBe(1)
  for (const event of frames) {
    expect(event).not.toHaveProperty('queuedMessages')
    if (event.type === 'snapshot' || event.type === 'reset') {
      expect(event.queueSummary).toBeDefined()
    }
  }
  const afterStop = history.page.queueSummary?.revision ?? 0
  await rig.deleteQueued(history.page.queueSummary?.newestPersonMessageId ?? '')
  const afterDelete = await rig.host.history({
    sessionId: HOST_TEST_SESSION,
    direction: 'tail',
    queueView: 'paged-v1'
  })
  expect(afterDelete.page.queueSummary).toMatchObject({ total: 0, resumeAvailable: false })
  expect(afterDelete.page.queueSummary?.revision).toBeGreaterThan(afterStop)
})
