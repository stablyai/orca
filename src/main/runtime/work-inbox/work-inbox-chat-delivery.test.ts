import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { closeTestJournalHostDatabase } from '../../native-chat/agent-session-journal/journal-host-database-test-support'
import { OrchestrationDb } from '../orchestration/db'
import { workInboxStoreFor } from './work-inbox-service'
import { WORK_INBOX_METHODS } from '../rpc/methods/work-inbox'
import type { RpcContext } from '../rpc/core'
import type { OrcaRuntimeService } from '../orca-runtime'
import { setStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  createQueuedMessageTestRig,
  eventually,
  type QueuedMessageTestRig
} from '../../native-chat/agent-session-wire/structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION
} from '../../native-chat/agent-session-wire/structured-agent-session-host-test-data'

let rig: QueuedMessageTestRig
let db: OrchestrationDb
beforeEach(async () => {
  rig = await createQueuedMessageTestRig()
  db = new OrchestrationDb(join(rig.root, 'inbox.db'))
  setStructuredAgentSessionHost(rig.host)
  vi.spyOn(Date, 'now').mockReturnValue(HOST_TEST_NOW)
})
afterEach(async () => {
  vi.restoreAllMocks()
  setStructuredAgentSessionHost(null)
  rig.host.stopDelivery()
  await rig.host.flushAllStreamedEvents()
  closeTestJournalHostDatabase(rig.root)
  db.close()
  await rm(rig.root, { recursive: true, force: true })
})
function fixture() {
  const store = workInboxStoreFor(db)
  const item = store.create({
    asker: {
      handle: `orca_session_id:${HOST_TEST_SESSION}`,
      paneKey: null,
      projectId: null,
      projectLabel: null,
      worktreeId: null,
      agentKind: 'codex'
    },
    question: 'Which task should continue?',
    optionLabels: ['Review'],
    allowFreeText: true,
    now: HOST_TEST_NOW - 3_600_000
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Resuming and answering only access the orchestration database.
  const runtime = { getOrchestrationDb: () => db } as OrcaRuntimeService
  const context: RpcContext = { runtime, caller: { kind: 'desktop' } }
  return { store, item, context }
}
const ask = WORK_INBOX_METHODS.find((method) => method.name === 'workInbox.ask')!
const answer = WORK_INBOX_METHODS.find((method) => method.name === 'workInbox.answer')!
const cancel = WORK_INBOX_METHODS.find((method) => method.name === 'workInbox.cancel')!

it('starts the original idle chat after a one-hour-old question and deduplicates answer retries', async () => {
  const { store, item, context } = fixture()
  expect(
    await ask.handler({ from: item.agentId, resume: item.id, timeoutMs: 0 }, context)
  ).toMatchObject({ timedOut: true })
  const params = {
    id: item.id,
    expectedRevision: 0,
    clientRequestId: 'late-answer',
    text: 'Review the original task'
  }
  const submitted = answer.handler(params, context)
  await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(1))
  const command = rig.dispatch.mock.calls[0][0]
  expect(command.sessionId).toBe(HOST_TEST_SESSION)
  expect(JSON.stringify(command)).toContain('Review the original task')
  await eventually(async () =>
    expect((await rig.submission(command.clientMessageId))?.handedOverAt).toBeDefined()
  )
  await rig.settleAccepted(command.clientMessageId, 'continuing original task')
  await submitted
  expect(store.get(item.id)?.status).toBe('delivered')
  await answer.handler(params, context)
  expect(rig.dispatch).toHaveBeenCalledTimes(1)
})
it('returns a live MCP answer without starting a second chat turn', async () => {
  const { item, context } = fixture()
  const waiting = ask.handler({ from: item.agentId, resume: item.id, timeoutMs: 1000 }, context)
  await answer.handler(
    { id: item.id, expectedRevision: 0, clientRequestId: 'live', text: 'Continue' },
    context
  )
  expect(await waiting).toMatchObject({ answer: { text: 'Continue' }, timedOut: false })
  expect(rig.dispatch).not.toHaveBeenCalled()
})
it('never starts a chat for closure without an answer', async () => {
  const { item, store, context } = fixture()
  await cancel.handler({ id: item.id, expectedRevision: 0 }, context)
  expect(store.get(item.id)?.status).toBe('cancelled')
  expect(rig.dispatch).not.toHaveBeenCalled()
})
it('keeps the answer durable and unacknowledged if its chat is unavailable', async () => {
  const { item, store, context } = fixture()
  setStructuredAgentSessionHost(null)
  await expect(
    answer.handler(
      { id: item.id, expectedRevision: 0, clientRequestId: 'offline', text: 'Keep this answer' },
      context
    )
  ).rejects.toThrow('work_inbox_chat_unavailable')
  expect(store.get(item.id)).toMatchObject({
    status: 'answered',
    answer: { text: 'Keep this answer' }
  })
  expect(rig.dispatch).not.toHaveBeenCalled()
})
it('rejects an agent-forged answer before starting any chat', async () => {
  const { item, context } = fixture()
  await expect(
    answer.handler(
      { id: item.id, expectedRevision: 0, clientRequestId: 'forged', text: 'Approved' },
      { ...context, caller: { kind: 'local-cli' } }
    )
  ).rejects.toThrow('only from the Orca app')
  expect(rig.dispatch).not.toHaveBeenCalled()
})
it('queues a late answer once behind an active turn without claiming delivery', async () => {
  const { item, store, context } = fixture()
  await rig.workingSend()
  const params = { id: item.id, expectedRevision: 0, clientRequestId: 'busy', text: 'Review later' }
  await answer.handler(params, context)
  await answer.handler(params, context)
  expect(await rig.drafts()).toHaveLength(1)
  expect(store.get(item.id)?.status).toBe('answered')
})
