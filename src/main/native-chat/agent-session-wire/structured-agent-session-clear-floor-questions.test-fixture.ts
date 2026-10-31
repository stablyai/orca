import { expect, vi } from 'vitest'
import { activeProviderContext } from '../../../shared/agent-session-provider-context'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../shared/agent-session-journal-item-key'
import { structuredRewindCut } from './structured-rewind-cut'
import {
  currentJournal,
  currentWork
} from './structured-agent-session-leftover-settlement.test-fixture'
import { asyncQuestionBody } from './structured-agent-session-async-question.test-fixture'
import {
  QUEUED_RIG_CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestOperationId
} from './structured-agent-session-host-test-data'

export function asyncRows(current: QueuedMessageTestRig) {
  const payload = currentWork(current).requestProjection(
    SESSION,
    'agent-session.current-requests.v2'
  ).items
  if (!payload || Array.isArray(payload) || payload.asyncQuestions === null) {
    throw new Error('expected negotiated v2 payload')
  }
  return payload.asyncQuestions
}

export async function expectClearFloorQuestionRecovery(current: QueuedMessageTestRig) {
  const started = await current.workingSend()
  await current.settleAccepted(started, 'before-clear')
  const journal = currentJournal(current)
  const earlier = await journal.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'turn-before-clear', ordinal: 1 },
    asyncQuestionBody('before-clear-question'),
    { fence: 1 }
  )
  const oldId = asyncRows(current)[0].id
  const clearFields = { command: 'clear' as const }
  expect(
    await current.host.conversationCommand(QUEUED_RIG_CALLER, {
      ...clearFields,
      envelope: current.envelope(
        clearFields,
        'agentSession.conversationCommand',
        hostTestOperationId()
      )
    })
  ).toMatchObject({ ok: true })
  const fence = () => current.store.getRecord(SESSION)!.lease.runtimeFence
  const floor = journal.context.floor()!
  const boundary = current.store.getRecord(SESSION)!.providerContextBoundary!.operationId
  expect(asyncRows(current)).toEqual([])
  const keptIdentity = {
    provider: 'codex' as const,
    threadId: THREAD,
    turnId: 'turn-kept',
    ordinal: 1
  }
  await journal.appendItem(keptIdentity, asyncQuestionBody('kept-question'), { fence: fence() })
  const keptId = asyncRows(current)[0].id
  await current.host.cancelCurrentQuestions({ sessionId: SESSION, ids: [keptId] }, 'phone')
  const targetId = hostTestOperationId()
  const targetBody = {
    kind: 'message' as const,
    role: 'user' as const,
    blocks: [{ type: 'text' as const, text: 'remove this answer' }]
  }
  const target = {
    id: targetId,
    result: current.host.send(QUEUED_RIG_CALLER, {
      body: targetBody,
      userSend: true,
      envelope: {
        ...current.envelope({ body: targetBody }, 'agentSession.send', targetId),
        expectedRuntimeFence: fence()
      }
    })
  }
  expect(await target.result).toMatchObject({ ok: true })
  await vi.waitFor(async () =>
    expect((await current.submission(target.id))?.handedOverAt).toBeDefined()
  )
  await current.settleAccepted(target.id, 'removed-after-clear')
  const removedIdentity = {
    provider: 'codex' as const,
    threadId: THREAD,
    turnId: 'turn-removed-after-clear',
    ordinal: 1
  }
  await journal.appendItem(removedIdentity, asyncQuestionBody('removed-question'), {
    fence: fence()
  })
  expect(asyncRows(current)).toHaveLength(1)
  const cut = structuredRewindCut(journal, {
    itemId: agentJournalSubmissionKey(target.id),
    provider: 'codex',
    nativeId: activeProviderContext(current.store.getRecord(SESSION)!).head!.handle.nativeId
  })
  if (!cut) {
    throw new Error('Expected canonical clear-floor rewind cut')
  }
  const fields = { itemId: agentJournalSubmissionKey(target.id), expectedEpoch: floor.epoch }
  expect(
    await current.host.rewind(QUEUED_RIG_CALLER, {
      ...fields,
      envelope: {
        ...current.envelope(fields, 'agentSession.rewind', hostTestOperationId()),
        expectedRuntimeFence: fence()
      }
    })
  ).toMatchObject({ ok: true })
  expect(journal.cursor().epoch).toBe(floor.epoch)
  expect(asyncRows(current)).toEqual([])
  expect(journal.questionSourceFacts().removed.has(agentJournalItemKey(removedIdentity))).toBe(true)
  // Fork replacement uses the actual cut, which deliberately omits the clear divider.
  await journal.replaceEpochItems('handle_forked', fence(), cut.kept)
  expect(journal.context.floor()).toBeNull()
  expect(journal.questionSourceFacts().clearOperationId).toBe(boundary)
  expect(asyncRows(current)).toEqual([])
  const payload = currentWork(current).requestProjection(
    SESSION,
    'agent-session.current-requests.v2'
  ).items
  if (!payload || Array.isArray(payload)) {
    throw new Error('Expected v2 payload')
  }
  expect(payload.context.boundary).toBe(agentJournalSubmissionKey(`context-clear:${boundary}`))
  const newIdentity = { ...keptIdentity, ordinal: 2 }
  const next = await journal.appendItem(newIdentity, asyncQuestionBody('new-call-after-rewind'), {
    fence: fence()
  })
  expect(asyncRows(current).map((record) => record.sourceRowId)).toEqual([next.itemId])
  await journal.appendTombstone(newIdentity, { fence: fence() })
  expect(asyncRows(current)).toEqual([])
  current.crashRestartHostProcess()
  await current.host.history({ sessionId: SESSION, direction: 'tail' })
  expect(asyncRows(current)).toEqual([])
  const owner = currentJournal(current).messageQuestions()
  const records = owner.repository.current(owner.source).records
  expect(records.filter((record) => record.sourceRowId === earlier.itemId)).toMatchObject([
    { id: oldId, resolution: { state: 'cancelled' } }
  ])
  expect(
    records.filter((record) => record.sourceRowId === agentJournalItemKey(keptIdentity))
  ).toMatchObject([{ id: keptId, resolution: { state: 'cancelled', reason: 'user' } }])
  expect(records.find((record) => record.sourceRowId === next.itemId)?.resolution).toMatchObject({
    state: 'cancelled',
    reason: 'source-replaced'
  })
}
