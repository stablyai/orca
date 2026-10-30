import { expect, type MockInstance } from 'vitest'
import type { AgentJournalSnapshot } from '../../../../../shared/agent-session-journal-types'
import type { createOrchestrationRpcHarness } from './rpc-test-harness'
import type { QueuedMessageTestRig } from '../../../../native-chat/agent-session-wire/structured-agent-session-queued-message-rig.test-fixture'
import { closeTestJournalHostDatabase } from '../../../../native-chat/agent-session-journal/journal-host-database-test-support'
import { projectStructuredAgentStartItem } from '../../../../../shared/structured-agent-start-projection'
import { projectStructuredAgentSessionStatusSummary } from '../../../../../shared/structured-agent-session-projection'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../../shared/agent-session-journal-types'
import { readFile } from 'node:fs/promises'
import '../../../../native-chat/agent-session-wire/structured-agent-session-queued-message-rig.test-fixture'
import { COORD } from './worker-start-card-contract-test-fixture'

export async function verifyWorkerStartCardScenario(input: {
  current: QueuedMessageTestRig
  scenario: string
  before: AgentJournalSnapshot
  task: string
  federated: boolean
  db: ReturnType<ReturnType<typeof createOrchestrationRpcHarness>['setup']>['db']
  append: MockInstance<QueuedMessageTestRig['host']['appendAgentStart']>
}): Promise<void> {
  const { current, scenario, before, task, federated, db, append } = input
  const snapshot = await current.host.journalSnapshot(COORD)
  const cards = snapshot.items.filter((item) => item.body.kind === 'agent-start')
  if (scenario !== 'success' && scenario !== 'federated') {
    expect(cards).toHaveLength(0)
    return
  }
  expect(cards).toHaveLength(1)
  const [card] = cards
  expect(snapshot.items.map(({ itemId }) => itemId)).toEqual([
    ...before.items.map(({ itemId }) => itemId),
    card.itemId
  ])
  expect(card.body).toMatchObject({
    kind: 'agent-start',
    task,
    ...(!federated
      ? { worker: { party: { address: 'term_worker', terminalHandle: 'term_worker' } } }
      : {})
  })
  if (card.body.kind !== 'agent-start') {
    throw new Error('missing start body')
  }
  if (federated) {
    expect(card.body.worker.party.address).toBe(`dispatch:${card.body.dispatchId}`)
  }
  const destination = append.mock.calls[0][0]
  await Promise.all([
    current.host.appendAgentStart(
      destination,
      { ...card.body, task: 'replayed task' },
      card.observedAt + 10
    ),
    current.host.appendAgentStart(destination, card.body, card.observedAt + 20)
  ])
  expect(
    (await current.host.journalSnapshot(COORD)).items.filter(
      (item) => item.body.kind === 'agent-start'
    )
  ).toEqual(cards)
  expect(projectStructuredAgentStartItem(card)).toMatchObject({
    role: 'system',
    agentStart: true,
    timestamp: card.observedAt,
    blocks: [{ type: 'text', text: task }]
  })
  expect(projectStructuredAgentSessionStatusSummary(snapshot.items, snapshot.submissions)).toEqual(
    projectStructuredAgentSessionStatusSummary(before.items, before.submissions)
  )
  // Full task survives removal of the orchestration rows it came from.
  db.resetAll()
  expect(
    (await current.host.journalSnapshot(COORD)).items.find((item) => item.itemId === card.itemId)
  ).toEqual(card)
  if (scenario === 'success') {
    const context = await current.host.continuationContext({
      sessionId: COORD,
      workspaceId: current.store.getConversation(COORD)!.location.workspaceId,
      expectedCursor: snapshot.cursor
    })
    expect(context).toMatchObject({ status: 'current' })
    if (context.status !== 'current' || !context.transcriptPath) {
      throw new Error('saved context missing')
    }
    const saved = await readFile(context.transcriptPath, 'utf8')
    expect(saved).toContain('Coordinate this work')
    expect(saved).not.toContain(task)
    expect(context.capturedText).not.toContain(task)
    await current.quitRestartHostProcess()
    await closeTestJournalHostDatabase(current.root)
    current.crashRestartHostProcess()
    const reopened = await current.host.journalSnapshot(COORD)
    expect(reopened.items.map(({ itemId }) => itemId)).toEqual(
      snapshot.items.map(({ itemId }) => itemId)
    )
    expect(reopened.items.filter(({ body }) => body.kind !== 'tool-call')).toEqual(
      snapshot.items.filter(({ body }) => body.kind !== 'tool-call')
    )
    const recovered = reopened.items.find(({ itemId }) => itemId === 'orca:caller-1')
    expect(recovered).toEqual({
      ...snapshot.items[1],
      revision: snapshot.items[1].revision + 1,
      recovered: true,
      recoveredAt: expect.any(Number),
      body: {
        kind: 'tool-call',
        name: 'shell',
        input: { command: 'inspect' },
        state: 'failed',
        endedAs: 'interrupted'
      }
    })
    expect(reopened.cursor.epoch).toBe(snapshot.cursor.epoch)
    expect(reopened.cursor.sequence).toBeGreaterThan(snapshot.cursor.sequence)
    const history = await current.host.history({ sessionId: COORD, direction: 'tail' })
    expect(history).toMatchObject({ ok: true, page: { items: reopened.items } })
  }
  const journal = current.host.collaboratorsForTests().sessions.get(COORD)!.journal
  if (scenario === 'success') {
    for (let index = 0; index < 3; index++) {
      await journal.appendItem(
        { provider: 'orca', clientMessageId: `pressure-${index}` },
        {
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'x'.repeat(750000) }]
        },
        {
          fence: current.store.getConversation(COORD)!.currentFence,
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        }
      )
    }
    const tail = await current.host.history({ sessionId: COORD, direction: 'tail' })
    if (!tail.ok) {
      throw new Error('pressure tail missing')
    }
    expect(tail.page.hasOlder).toBe(true)
    expect(tail.page.items.some(({ itemId }) => itemId === card.itemId)).toBe(false)
    const older = await current.host.history({
      sessionId: COORD,
      direction: 'before',
      cursor: tail.page.window.nextCursor
    })
    if (!older.ok) {
      throw new Error('pressure older page missing')
    }
    expect(older.page.items.find(({ itemId }) => itemId === card.itemId)).toEqual(card)
  }
  await journal.appendTombstone(
    { provider: 'orca', clientMessageId: `agent-start:${card.body.dispatchId}` },
    { fence: current.store.getConversation(COORD)!.currentFence }
  )
  if (scenario === 'success') {
    await current.quitRestartHostProcess()
    await closeTestJournalHostDatabase(current.root)
    current.crashRestartHostProcess()
  }
  await current.host.appendAgentStart(destination, card.body, card.observedAt + 30)
  expect(
    (await current.host.journalSnapshot(COORD)).items.some((item) => item.itemId === card.itemId)
  ).toBe(false)
}
