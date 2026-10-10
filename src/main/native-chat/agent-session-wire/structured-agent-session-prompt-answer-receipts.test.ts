// A prompt answer accepts through its own command receipt, committed with the resolved revision
// before the provider hears the answer: a retry answers from that receipt and the provider hears
// each answer once.

import { beforeEach, describe, expect, it, type Mock } from 'vitest'
import { AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS } from '../../../shared/agent-session-host-authority'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody
} from '../../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import {
  openTestJournalHostDatabase,
  SAVED_BY_NEWER_ORCA
} from '../agent-session-journal/journal-host-database-test-support'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  attach,
  CALLER,
  envelope,
  hostTestState,
  seedApproval
} from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD
} from './structured-agent-session-host-test-data'

const OLD = NOW - AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS - 60_000
const FUTURE = NOW + 6 * 60_000
const CONFLICT = {
  ok: false,
  refusal: { code: 'agent_session_operation_conflict', details: { reason: 'operationIdReused' } }
}
const UNKNOWN = { ok: false, refusal: { code: 'agent_session_operation_unknown' } }
/** The provider identity `seedApproval` raises its prompt under. */
const PROMPT = { provider: 'codex' as const, threadId: THREAD, turnId: 'turn-1', ordinal: 99 }

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let answerPrompt: Mock<StructuredAgentSessionAdapter['answerPrompt']>
let acquire: Mock<StructuredAgentSessionAdapter['acquire']>
let serial = 0

beforeEach(() => {
  ;({ root, store, host, answerPrompt, acquire } = hostTestState())
})

function opId(at = NOW): string {
  serial += 1
  return `${at}-${serial.toString(16).padStart(32, 'd')}`
}

async function seeded() {
  await attach()
  return seedApproval()
}

function answer(
  prompt: { itemId: string; revision: number },
  clientOperationId: string,
  optionId = 'allow'
) {
  const fields = { itemId: prompt.itemId, expectedRevision: prompt.revision, optionId }
  return {
    envelope: envelope('agentSession.respondTo:approval', fields, { clientOperationId }),
    kind: 'approval' as const,
    ...fields
  }
}

function receipt(id: string, callerKey = CALLER.callerKey) {
  return store.readCommandReceipt({ kind: 'caller', callerKey }, id)
}

function journal() {
  const open = host.collaboratorsForTests().sessions.get(SESSION)?.journal
  if (!open) {
    throw new Error('expected an open conversation')
  }
  return open
}

function promptBody(itemId: string): AgentJournalItemBody {
  const body = journal().itemBody(itemId)
  if (!body) {
    throw new Error(`no item ${itemId}`)
  }
  return body
}

/** The provider writes the answered prompt again, as a later echo of it would. */
async function reviseFromProvider(itemId: string): Promise<void> {
  const body = promptBody(itemId)
  if (body.kind !== 'approval') {
    throw new Error('expected an approval')
  }
  const events = acquire.mock.calls.at(-1)?.[0].events
  events?.appendItem(
    PROMPT,
    {
      ...body,
      resolution: { ...body.resolution, resolvedBy: 'provider-echo', resolvedAt: NOW + 1 }
    },
    { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await host.flushStreamedEvents(SESSION)
}

/** What a rewind does to the conversation: a new epoch, the prompt rebuilt into it as it stands. */
async function rewindKeepingPrompt(itemId: string): Promise<void> {
  const fence = store.getRecord(SESSION)!.lease.runtimeFence
  await journal().replaceEpochItems('handle_forked', fence, [
    { identity: PROMPT, body: promptBody(itemId), turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  ])
}

function failReceiptWrites(): () => void {
  const db = openTestJournalHostDatabase(root).db
  db.exec(`CREATE TRIGGER fail_prompt_receipt BEFORE INSERT ON agent_session_command_receipts
    BEGIN SELECT RAISE(ABORT, 'receipt unavailable'); END`)
  return () => db.exec('DROP TRIGGER fail_prompt_receipt')
}

async function resolution(itemId: string) {
  const page = await host.history({ sessionId: SESSION, direction: 'tail' })
  const item = page.ok ? page.page.items.find((entry) => entry.itemId === itemId) : undefined
  return item?.body.kind === 'approval' ? item.body.resolution.state : undefined
}

describe('a prompt answer', () => {
  it.each([
    ['older than a day', OLD],
    ['six minutes ahead', FUTURE]
  ])('accepts an id %s with its resolved revision', async (_case, at) => {
    const prompt = await seeded()
    const id = opId(at)
    expect(await host.respondToPrompt(CALLER, answer(prompt, id))).toMatchObject({
      ok: true,
      replayed: false,
      value: { itemId: prompt.itemId, resolution: { state: 'resolved' } }
    })
    expect(receipt(id)).toMatchObject({
      verdict: 'readable',
      receipt: { method: 'agentSession.respondTo:approval', result: { kind: 'prompt-answer' } }
    })
    expect(answerPrompt).toHaveBeenCalledOnce()
  })

  it('delivers once for the same id twice, in turn or at once', async () => {
    const prompt = await seeded()
    const params = answer(prompt, opId())
    const [first, second] = await Promise.all([
      host.respondToPrompt(CALLER, params),
      host.respondToPrompt(CALLER, params)
    ])
    const third = await host.respondToPrompt(CALLER, params)
    expect(first).toMatchObject({ ok: true, replayed: false })
    expect(second).toMatchObject({
      ok: true,
      replayed: true,
      value: { revision: prompt.revision + 1 }
    })
    expect(third).toMatchObject({
      ok: true,
      replayed: true,
      value: { revision: prompt.revision + 1 }
    })
    expect(answerPrompt).toHaveBeenCalledOnce()
  })

  it('refuses the same id with another choice', async () => {
    const prompt = await seeded()
    const id = opId()
    await host.respondToPrompt(CALLER, answer(prompt, id))
    expect(await host.respondToPrompt(CALLER, answer(prompt, id, 'deny'))).toMatchObject(CONFLICT)
    expect(answerPrompt).toHaveBeenCalledOnce()
  })

  it('points another id at the revision that already holds its choice and delivers nothing', async () => {
    const prompt = await seeded()
    await host.respondToPrompt(CALLER, answer(prompt, opId()))
    const alias = opId()
    const other = { callerKey: 'client-2' }
    expect(await host.respondToPrompt(other, answer(prompt, alias))).toMatchObject({
      ok: true,
      replayed: false,
      value: { revision: prompt.revision + 1 }
    })
    expect(receipt(alias, other.callerKey)).toMatchObject({
      receipt: {
        result: {
          kind: 'prompt-answer',
          itemId: prompt.itemId,
          revision: prompt.revision + 1,
          resolution: { state: 'resolved', selectedOptionId: 'allow' }
        }
      }
    })
    expect(await host.respondToPrompt(other, answer(prompt, alias))).toMatchObject({
      ok: true,
      replayed: true
    })
    expect(answerPrompt).toHaveBeenCalledOnce()
  })

  it('rolls the revision back when its receipt cannot be saved', async () => {
    const prompt = await seeded()
    const id = opId()
    const restore = failReceiptWrites()
    await expect(host.respondToPrompt(CALLER, answer(prompt, id))).rejects.toThrow(
      'receipt unavailable'
    )
    restore()
    expect(await resolution(prompt.itemId)).toBe('pending')
    expect(receipt(id)).toEqual({ verdict: 'absent' })
    expect(store.listOperationRows().find((row) => row.operationId === id)).toBeUndefined()
  })

  it('answers an unreadable receipt as unknown without asking the provider', async () => {
    const prompt = await seeded()
    const id = opId()
    openTestJournalHostDatabase(root)
      .db.prepare(
        `INSERT INTO agent_session_command_receipts (operation_id, session_id, caller_key, method,
          fingerprint, status, result_json, rejection_json, accepted_at)
         VALUES (?, ?, ?, 'agentSession.respondTo:approval', 'x', 'accepted', '{', NULL, 0)`
      )
      .run(id, SESSION, CALLER.callerKey)
    expect(await host.respondToPrompt(CALLER, answer(prompt, id))).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_operation_unknown' }
    })
    expect(answerPrompt).not.toHaveBeenCalled()
    expect(await resolution(prompt.itemId)).toBe('pending')
  })

  it("refuses with the update words when a newer Orca's journal holds the chat", async () => {
    const prompt = await seeded()
    const id = opId()
    Object.defineProperty(openTestJournalHostDatabase(root), 'readOnly', { value: true })
    expect(await host.respondToPrompt(CALLER, answer(prompt, id))).toMatchObject({
      ok: false,
      ...SAVED_BY_NEWER_ORCA
    })
    expect(receipt(id)).toEqual({ verdict: 'absent' })
  })

  it('records nothing for a refusal before acceptance', async () => {
    const prompt = await seeded()
    const id = opId()
    expect(await host.respondToPrompt(CALLER, answer(prompt, id, 'deny'))).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_operation_invalid' }
    })
    expect(receipt(id)).toEqual({ verdict: 'absent' })
    expect(store.listOperationRows().find((row) => row.operationId === id)).toBeUndefined()
  })

  it('replays the resolution it was accepted with after the provider revises the prompt', async () => {
    const prompt = await seeded()
    const params = answer(prompt, opId())
    const first = await host.respondToPrompt(CALLER, params)
    expect(first).toMatchObject({ ok: true, replayed: false })
    await reviseFromProvider(prompt.itemId)
    expect(journal().item(prompt.itemId)?.revision).toBe(prompt.revision + 2)
    const replay = await host.respondToPrompt(CALLER, params)
    expect(replay).toEqual({ ...first, replayed: true, cursor: expect.anything() })
    expect(answerPrompt).toHaveBeenCalledOnce()
  })

  it('replays the revision another id acknowledged after the provider revises the prompt', async () => {
    const prompt = await seeded()
    await host.respondToPrompt(CALLER, answer(prompt, opId()))
    const other = { callerKey: 'client-2' }
    const params = answer(prompt, opId())
    const first = await host.respondToPrompt(other, params)
    await reviseFromProvider(prompt.itemId)
    const replay = await host.respondToPrompt(other, params)
    expect(replay).toEqual({ ...first, replayed: true, cursor: expect.anything() })
    expect(replay).toMatchObject({
      value: { revision: prompt.revision + 1, resolution: { resolvedBy: CALLER.callerKey } }
    })
  })

  it.each([
    ['its own answer', CALLER],
    ['the answer another id acknowledged', { callerKey: 'client-2' }]
  ])(
    'replays the accepted answer after a rewind, never answering again: %s',
    async (_case, caller) => {
      const prompt = await seeded()
      const params = answer(prompt, opId())
      if (caller !== CALLER) {
        await host.respondToPrompt(CALLER, answer(prompt, opId()))
      }
      const first = await host.respondToPrompt(caller, params)
      expect(first).toMatchObject({ ok: true, replayed: false })
      await rewindKeepingPrompt(prompt.itemId)
      expect(journal().item(prompt.itemId)?.revision).not.toBe(prompt.revision + 1)
      expect(await host.respondToPrompt(caller, params)).toEqual({
        ...first,
        replayed: true,
        cursor: expect.anything()
      })
      expect(answerPrompt).toHaveBeenCalledOnce()
    }
  )

  it('replays a grouped answer whole after a rewind, free text included', async () => {
    await attach()
    const question = { ...PROMPT, ordinal: 100 }
    acquire.mock.calls.at(-1)?.[0].events?.appendItem(
      question,
      {
        kind: 'question',
        question: '2 grouped questions',
        options: [],
        questions: [
          {
            id: 'q1',
            question: 'Targets',
            multiSelect: true,
            options: [
              { id: 'web', label: 'Web' },
              { id: 'mobile', label: 'Mobile' }
            ]
          },
          { id: 'q2', question: 'Host', multiSelect: false, options: [], freeTextQuestionId: 'q2' }
        ],
        resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
      },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    await host.flushStreamedEvents(SESSION)
    const itemId = agentJournalItemKey(question)
    const answers = [
      { questionId: 'q1', optionIds: ['web', 'mobile'] },
      { questionId: 'q2', optionIds: [], other: 'SSH host' }
    ]
    const fields = { itemId, expectedRevision: journal().item(itemId)!.revision, answers }
    const params = {
      envelope: envelope('agentSession.respondTo:question', fields, { clientOperationId: opId() }),
      kind: 'question' as const,
      ...fields
    }
    const first = await host.respondToPrompt(CALLER, params)
    expect(first).toMatchObject({ ok: true, value: { resolution: { answers } } })
    await journal().replaceEpochItems(
      'handle_forked',
      store.getRecord(SESSION)!.lease.runtimeFence,
      []
    )
    expect(await host.respondToPrompt(CALLER, params)).toEqual({
      ...first,
      replayed: true,
      cursor: expect.anything()
    })
    expect(answerPrompt).toHaveBeenCalledOnce()
  })

  it('answers unknown, never success, when acknowledging an answer cannot be recorded', async () => {
    const prompt = await seeded()
    await host.respondToPrompt(CALLER, answer(prompt, opId()))
    const other = { callerKey: 'client-2' }
    const id = opId()
    const restore = failReceiptWrites()
    expect(await host.respondToPrompt(other, answer(prompt, id))).toMatchObject(UNKNOWN)
    restore()
    expect(receipt(id, other.callerKey)).toEqual({ verdict: 'absent' })
    expect(answerPrompt).toHaveBeenCalledOnce()
  })

  it('refuses a Stop reusing its id, and an answer reusing a Stop id', async () => {
    const prompt = await seeded()
    const answered = opId()
    await host.respondToPrompt(CALLER, answer(prompt, answered))
    expect(
      await host.cancel(CALLER, {
        envelope: envelope('agentSession.cancel', {}, { clientOperationId: answered })
      })
    ).toMatchObject(CONFLICT)
    const second = await seedApproval('approve')
    const stopped = opId()
    await host.cancel(CALLER, {
      envelope: envelope('agentSession.cancel', {}, { clientOperationId: stopped })
    })
    expect(await host.respondToPrompt(CALLER, answer(second, stopped, 'approve'))).toMatchObject(
      CONFLICT
    )
    expect(receipt(stopped)).toEqual({ verdict: 'absent' })
  })
})
