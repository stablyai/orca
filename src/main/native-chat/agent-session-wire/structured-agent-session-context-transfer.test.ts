import { mkdir, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  agentSessionRecoveryExportRoot,
  RECOVERY_EXPORT_SLOTS
} from '../agent-session-context-recovery-exports'
import * as storedAgentRecord from '../../../shared/agent-session/lifecycle/agent-session-record-stored-form'
import { persistRewindRecord } from './structured-rewind-recovery'
import {
  parseAgentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  contextTransferFixture,
  transferEventually as eventually,
  TRANSFER_CALLER as CALLER
} from './structured-agent-session-context-transfer.test-fixture'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalTurnBody } from '../../../shared/agent-session/lifecycle/agent-session-turn-record'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session/lifecycle/agent-session-mutation-envelope'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { deriveContextTransferState } from '../agent-session-journal/context-transfer-state'

let fixture: Awaited<ReturnType<typeof contextTransferFixture>>
beforeEach(async () => {
  fixture = await contextTransferFixture()
})
afterEach(async () => {
  await fixture.dispose()
})

describe('native saved-context recovery delivery', () => {
  it('commits injection independently before P, retains it across reopen, and never prefixes the displayed input', async () => {
    const injecting = Promise.withResolvers<void>()
    const inject = vi.fn<NonNullable<StructuredAgentSessionAdapter['injectHistoricalContext']>>(
      async () => {
        await injecting.promise
        return { kind: 'injected', requestId: '17' }
      }
    )
    const { journal } = await fixture.recoverSavedChat(inject)
    const id = await fixture.accept('What was the number?')
    await eventually(() => expect(inject).toHaveBeenCalledOnce())
    expect(inject.mock.calls[0][0].messages.map((message) => message.text).join('\n')).toContain(
      '42'
    )
    expect((await fixture.submission(id))?.handedOverAt).toBeUndefined()
    expect(fixture.dispatch).toHaveBeenCalledTimes(1)
    expect(journal.contextTransfers.read().find((row) => row.kind === 'delivery')).toMatchObject({
      mode: 'inject',
      writeStartedAt: expect.any(Number),
      outcome: null
    })
    const write = journal.resolveDispatch.bind(journal)
    const beforePending = vi
      .spyOn(journal, 'resolveDispatch')
      .mockImplementation(async (...args) => {
        if (args[0].clientMessageId === id && args[0].state === 'pending') {
          throw new Error('host ended before the carrier pending write')
        }
        return write(...args)
      })
    injecting.resolve()
    await eventually(async () =>
      expect((await fixture.submission(id))?.dispatchState).toBe('rejected')
    )
    expect((await fixture.submission(id))?.handedOverAt).toBeUndefined()
    expect(fixture.dispatch).toHaveBeenCalledTimes(1)
    expect(journal.contextTransfers.read().find((row) => row.kind === 'target')).toMatchObject({
      firstInputId: null
    })
    expect(journal.contextTransfers.read().find((row) => row.kind === 'delivery')).toMatchObject({
      outcome: { kind: 'injected', requestId: '17' }
    })
    beforePending.mockRestore()
    await fixture.restart()
    expect((await fixture.submission(id))?.dispatchState).not.toBe('accepted')
    const q = await fixture.accept('And now?')
    await eventually(async () =>
      expect((await fixture.submission(q))?.dispatchState).toBe('accepted')
    )
    expect(inject).toHaveBeenCalledOnce()
    expect(fixture.dispatch.mock.calls.at(-1)?.[0].body).toEqual(hostTestMessage('And now?'))
  })

  it('settles an unknown inline carrier only from its exact target echo, preserving one original bubble', async () => {
    const { journal, native } = await fixture.recoverSavedChat(async () => ({
      kind: 'unsupported'
    }))
    fixture.dispatch.mockResolvedValueOnce({ state: 'unknown', reason: 'reply lost' })
    const id = await fixture.accept('Please use the saved number')
    await eventually(async () =>
      expect((await fixture.submission(id))?.dispatchState).toBe('unknown')
    )
    const encoded = fixture.dispatch.mock.calls.at(-1)![0].body
    expect(JSON.stringify(encoded)).toContain('orca_context_handoff')
    const delivery = journal.contextTransfers
      .read()
      .find((row) => row.kind === 'delivery' && row.mode === 'inline')!
    expect(delivery).toMatchObject({ carrierInputId: id, outcome: { kind: 'unknown' } })
    const identity = {
      provider: 'codex' as const,
      threadId: native(),
      turnId: 'late-carrier',
      ordinal: 0
    }
    const db = openTestJournalHostDatabase(fixture.root).db
    const prepare = vi.spyOn(db, 'prepare')
    const decode = vi.spyOn(storedAgentRecord, 'decodePersistedAgentSessionRecord')
    journal.contextTransfers.reopen()
    expect(
      prepare.mock.calls.filter(([sql]) => sql.startsWith('SELECT id, session_id, handoff_id'))
    ).toHaveLength(1)
    prepare.mockClear()
    await journal.appendLifecycleBatch({
      settlementId: 'late-carrier-batch',
      fence: fixture.store.requireWritableRecord(SESSION).lease.runtimeFence,
      mutations: Array.from({ length: 8 }, (_, ordinal) => ({
        kind: 'item' as const,
        identity: { ...identity, ordinal },
        body: encoded,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      }))
    })
    expect(
      prepare.mock.calls.filter(([sql]) => sql.startsWith('SELECT id, session_id, handoff_id'))
    ).toHaveLength(0)
    expect(
      prepare.mock.calls.filter(([sql]) =>
        sql.startsWith('SELECT record_json FROM agent_session_records')
      )
    ).toHaveLength(1)
    prepare.mockClear()
    expect(decode).toHaveBeenCalledOnce()
    // The committed receipt updated the cached facts, so reading them reloads nothing.
    const committedFacts = journal.contextTransfers.read()
    expect(
      prepare.mock.calls.filter(([sql]) => sql.startsWith('SELECT id, session_id, handoff_id'))
    ).toHaveLength(0)
    expect(committedFacts.find((row) => row.id === delivery.id)).toMatchObject({
      outcome: { kind: 'inline-accepted' }
    })
    decode.mockRestore()
    prepare.mockRestore()
    expect((await fixture.submission(id))?.dispatchState).toBe('accepted')
    expect(journal.contextTransfers.read().find((row) => row.id === delivery.id)).toMatchObject({
      outcome: { kind: 'inline-accepted', clientMessageId: id }
    })
    const snapshot = await fixture.host.journalSnapshot(SESSION)
    expect(JSON.stringify(snapshot)).not.toContain('orca_context_handoff')
    expect(journal.itemBody(agentJournalSubmissionKey(id))).toEqual(
      hostTestMessage('Please use the saved number')
    )
  })
  it('keeps ingesting provider output when an accepted carrier receipt cannot be saved', async () => {
    const { journal, native } = await fixture.recoverSavedChat(async () => ({
      kind: 'unsupported'
    }))
    fixture.dispatch.mockResolvedValueOnce({ state: 'admitted' })
    const id = await fixture.accept('Use the number now')
    await eventually(() => expect(fixture.dispatch).toHaveBeenCalledTimes(2))
    const encoded = fixture.dispatch.mock.calls.at(-1)![0].body
    const sink = fixture.acquire.mock.calls.at(-1)![0].events!
    const identity = { provider: 'codex' as const, threadId: native(), turnId: 'echo', ordinal: 0 }
    const db = openTestJournalHostDatabase(fixture.root).db
    db.exec(`CREATE TEMP TRIGGER refuse_inline_receipt BEFORE INSERT ON agent_session_context_transfers
      WHEN json_extract(NEW.record_json, '$.outcome.kind') = 'inline-accepted'
      BEGIN SELECT RAISE(ABORT, 'receipt write failed'); END`)
    try {
      sink.appendItem(identity, encoded, { turnScope: AGENT_JOURNAL_THREAD_SCOPE })
      await fixture.host.flushStreamedEvents(SESSION)
    } finally {
      db.exec('DROP TRIGGER refuse_inline_receipt')
    }
    sink.appendItem(
      { ...identity, ordinal: 1 },
      { ...hostTestMessage('Provider reply 42'), role: 'assistant' },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    await fixture.host.flushStreamedEvents(SESSION)
    expect((await fixture.submission(id))?.dispatchState).toBe('accepted')
    expect(JSON.stringify(await fixture.host.journalSnapshot(SESSION))).toContain(
      'Provider reply 42'
    )
    const records = journal.contextTransfers.read()
    expect(records.find((row) => row.kind === 'delivery' && row.mode === 'inline')).toMatchObject({
      carrierInputId: id,
      writeStartedAt: expect.any(Number),
      outcome: null
    })
    expect(
      deriveContextTransferState(
        records,
        fixture.store.requireWritableRecord(SESSION).providerHandleChain
      ).kind
    ).toBe('uncertain')
  })
  it('words a failed context write as an Orca fault and an unproved history write as undelivered', async () => {
    const inject = vi.fn<NonNullable<StructuredAgentSessionAdapter['injectHistoricalContext']>>(
      async () => {
        throw new Error('connection reset')
      }
    )
    await fixture.recoverSavedChat(inject)
    const db = openTestJournalHostDatabase(fixture.root).db
    db.exec(`CREATE TEMP TRIGGER refuse_delivery BEFORE INSERT ON agent_session_context_transfers
      WHEN NEW.kind = 'delivery' BEGIN SELECT RAISE(ABORT, 'disk full'); END`)
    let local: string
    try {
      local = await fixture.accept('First try')
      await eventually(async () =>
        expect((await fixture.submission(local))?.dispatchState).toBe('rejected')
      )
    } finally {
      db.exec('DROP TRIGGER refuse_delivery')
    }
    expect(await fixture.submission(local)).toMatchObject({
      rejection: { kind: 'hostFault', neverReachedAgent: true },
      reason: "Orca ran into a problem, so this didn't go through. Try again."
    })
    expect(inject).not.toHaveBeenCalled()

    const unproved = await fixture.accept('Second try')
    await eventually(async () =>
      expect((await fixture.submission(unproved))?.dispatchState).toBe('rejected')
    )
    expect(inject).toHaveBeenCalledOnce()
    expect(await fixture.submission(unproved)).toMatchObject({
      rejection: { kind: 'notDelivered', neverReachedAgent: true },
      reason: 'This message was not delivered. Send it again to continue.'
    })
  })
  it('parks Q behind known live work, then the real completion commit wakes idle replacement without replaying unknown P', async () => {
    const { native } = await fixture.recoverSavedChat(async () => ({ kind: 'unsupported' }))
    fixture.dispatch.mockResolvedValueOnce({ state: 'unknown', reason: 'carrier reply lost' })
    const p = await fixture.accept('Unknown request must not run again')
    await eventually(async () =>
      expect((await fixture.submission(p))?.dispatchState).toBe('unknown')
    )
    await fixture.host.close(SESSION, 'evict')
    let running = true
    fixture.host.deps.adapter.holdsDispatch = () => running
    fixture.host.deps.adapter.liveTurnId = () => (running ? 'known-running' : null)
    expect(
      await fixture.host.attach(
        CALLER,
        hostTestAttachParams(fixture.store.requireWritableRecord(SESSION).lease.runtimeFence)
      )
    ).toMatchObject({ ok: true })
    await eventually(() => expect(fixture.childPhase()).toBe('ready'))
    const closing = vi.spyOn(fixture.host.deps.adapter, 'closeSession').mockClear()
    const before = fixture.dispatch.mock.calls.length
    const q = await fixture.accept('Continue with the saved number')
    await fixture.host.flushStreamedEvents(SESSION)
    expect(fixture.dispatch).toHaveBeenCalledTimes(before)
    expect(closing).not.toHaveBeenCalled()
    expect((await fixture.submission(q))?.handedOverAt).toBeUndefined()
    const oldNative = native()
    running = false
    fixture.acquire.mock.calls.at(-1)![0].events!.appendItem(
      { provider: 'codex', threadId: oldNative, turnId: 'known-running', ordinal: 1 },
      agentJournalTurnBody({
        turnId: 'known-running',
        state: 'completed',
        outcome: 'success',
        completedAt: NOW
      }),
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    await fixture.host.flushStreamedEvents(SESSION)
    await eventually(async () =>
      expect((await fixture.submission(q))?.dispatchState).toBe('accepted')
    )
    expect(closing).toHaveBeenCalledOnce()
    expect(native()).not.toBe(oldNative)
    expect((await fixture.submission(p))?.dispatchState).toBe('unknown')
    expect(fixture.dispatch).toHaveBeenCalledTimes(before + 1)
    const words = JSON.stringify(fixture.dispatch.mock.calls.at(-1)![0].body)
    expect(words).toContain('42')
    expect(words).toContain('Continue with the saved number')
    expect(words).not.toContain('Unknown request must not run again')
  })
  it('retires completed context at clear, then recovers a later genuinely missing ordinary native context', async () => {
    const inject = vi.fn(async () => ({ kind: 'injected' as const, requestId: '21' }))
    const { journal, lose } = await fixture.recoverSavedChat(inject)
    const first = await fixture.accept('Use 42')
    await eventually(async () =>
      expect((await fixture.submission(first))?.dispatchState).toBe('accepted')
    )
    const oldReceipt = journal.contextTransfers.read().find((row) => row.kind === 'delivery')
    const kept = journal.snapshot().items.flatMap((item) => {
      const identity = parseAgentJournalItemKey(item.itemId)
      return identity
        ? [
            {
              identity,
              body: item.body,
              observedAt: item.observedAt,
              ownerFence: journal.itemFence(item.itemId) ?? 1,
              turnScope: item.turnScope
            }
          ]
        : []
    })
    const rewind = {
      operationId: 'completed-context-rewind',
      callerKey: CALLER.callerKey,
      itemId: journal.snapshot().items[0].itemId,
      expectedEpoch: journal.cursor().epoch,
      phase: 'provider-succeeded' as const
    }
    const fence = fixture.store.requireWritableRecord(SESSION).lease.runtimeFence
    await persistRewindRecord(fixture.store, SESSION, fence, rewind)
    await journal.replaceEpochItems('handle_forked', fence, kept, (cursor) =>
      fixture.store.conversationReceipts.rewind(SESSION, fence, rewind, cursor)
    )
    const rewound = journal.contextTransfers.read()
    expect(rewound.filter((row) => row.kind === 'handoff')).toHaveLength(1)
    expect(rewound.find((row) => row.id === oldReceipt?.id)).toEqual(oldReceipt)
    expect(rewound).toContainEqual(expect.objectContaining({ kind: 'closure', cause: 'rewind' }))
    // Recover once more so successful clear must retire a completed, currently applicable H.
    await fixture.host.close(SESSION, 'evict')
    lose()
    const afterRewind = await fixture.accept('Remember 42 after rewind')
    await eventually(async () =>
      expect((await fixture.submission(afterRewind))?.dispatchState).toBe('accepted')
    )
    const command = 'clear' as const
    expect(
      await fixture.host.conversationCommand(CALLER, {
        command,
        envelope: {
          sessionId: SESSION,
          clientOperationId: hostTestOperationId(),
          expectedRuntimeFence: fixture.store.requireWritableRecord(SESSION).lease.runtimeFence,
          payloadFingerprint: computeAgentSessionPayloadFingerprint({
            method: 'agentSession.conversationCommand',
            sessionId: SESSION,
            fields: { command }
          })
        }
      })
    ).toMatchObject({ ok: true, value: { state: 'completed' } })
    const next = await fixture.accept('Only remember 77 after clear')
    await eventually(async () =>
      expect((await fixture.submission(next))?.dispatchState).toBe('accepted')
    )
    await fixture.host.close(SESSION, 'evict')
    lose()
    const q = await fixture.accept('What is the new number?')
    await eventually(async () =>
      expect((await fixture.submission(q))?.dispatchState).toBe('accepted')
    )
    expect(inject).toHaveBeenCalledTimes(3)
    const words = JSON.stringify(inject.mock.calls.at(-1))
    expect(words).toContain('77')
    expect(words).not.toContain('saved answer is 42')
    const current = fixture.host
      .collaboratorsForTests()
      .sessions.get(SESSION)!
      .journal.contextTransfers.read()
    expect(current.find((row) => row.id === oldReceipt?.id)).toEqual(oldReceipt)
    expect(current.some((row) => row.kind === 'closure' && row.cause === 'context-clear')).toBe(
      true
    )
  })

  it('keeps an advertised recovery export when the terminal hand-off exports newer context', async () => {
    const recovery = await fixture.recoverSavedChat(async () => ({ kind: 'unsupported' }))
    fixture.dispatch.mockResolvedValueOnce({ state: 'unknown', reason: 'lost native reply' })
    const p = await fixture.accept('UNCERTAIN input stays out of saved history')
    await eventually(async () =>
      expect((await fixture.submission(p))?.dispatchState).toBe('unknown')
    )
    const records = recovery.journal.contextTransfers.read()
    const handoff = records.find((row) => row.kind === 'handoff')
    const delivery = records.find((row) => row.kind === 'delivery' && row.mode === 'inline')
    if (handoff?.kind !== 'handoff' || delivery?.kind !== 'delivery') {
      throw new Error('Missing recovery delivery')
    }
    const exported = await recovery.journal.exportRecoveryContext(handoff)
    expect(delivery.selection.coverageText).toContain(exported)
    const frozen = await readFile(exported!, 'utf8')
    const preview = await fixture.host.continuationContext({
      sessionId: SESSION,
      workspaceId: fixture.store.requireWritableRecord(SESSION).location.workspaceId,
      expectedCursor: recovery.journal.cursor()
    })
    expect(preview).toMatchObject({ status: 'current', transcriptPath: expect.any(String) })
    expect(preview.status === 'current' && preview.transcriptPath).not.toBe(exported)
    expect(await readFile(exported!, 'utf8')).toBe(frozen)
  })
  it('delivers bounded saved history without a full-history path when no export slot is free', async () => {
    const recovery = await fixture.recoverSavedChat(async () => ({ kind: 'unsupported' }))
    const exports = agentSessionRecoveryExportRoot(fixture.root)
    for (let slot = 0; slot < RECOVERY_EXPORT_SLOTS; slot++) {
      await mkdir(join(exports, `slot-${slot}`), { recursive: true, mode: 0o700 })
    }
    const id = await fixture.accept('Use what you remember')
    await eventually(async () =>
      expect((await fixture.submission(id))?.dispatchState).toBe('accepted')
    )
    const sent = JSON.stringify(fixture.dispatch.mock.calls.at(-1)![0].body)
    expect(sent).toContain('The saved answer is 42')
    expect(sent).toMatch(/selected \d+ intact items; omitted \d+/)
    expect(sent).not.toContain('Read omitted saved history at')
    expect(sent).toContain('Use what you remember')
    const delivery = recovery.journal.contextTransfers
      .read()
      .find((row) => row.kind === 'delivery' && row.mode === 'inline')
    expect(delivery).toMatchObject({ outcome: { kind: 'inline-accepted', clientMessageId: id } })
    expect(await readdir(exports)).toHaveLength(RECOVERY_EXPORT_SLOTS)
  })
  it('exports only an authentic frozen source and performs no transfer SQL for ordinary output', async () => {
    const db = openTestJournalHostDatabase(fixture.root).db
    const prepare = vi.spyOn(db, 'prepare')
    const decode = vi.spyOn(storedAgentRecord, 'decodePersistedAgentSessionRecord')
    const journal = fixture.host.collaboratorsForTests().sessions.get(SESSION)!.journal
    for (let ordinal = 0; ordinal < 4; ordinal++) {
      await journal.appendItem(
        { provider: 'codex', threadId: 'ordinary', turnId: 'output', ordinal },
        hostTestMessage('ordinary output'),
        { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
    }
    expect(
      prepare.mock.calls.filter(([sql]) =>
        /agent_session_context_transfers|SELECT record_json FROM agent_session_records/.test(sql)
      )
    ).toEqual([])
    expect(decode).not.toHaveBeenCalled()
    prepare.mockClear()
    const recovery = await fixture.recoverSavedChat(async () => ({ kind: 'unsupported' }))
    const handoff = recovery.journal.contextTransfers.read().find((row) => row.kind === 'handoff')
    if (handoff?.kind !== 'handoff') {
      throw new Error('Missing frozen source')
    }
    expect(await recovery.journal.exportRecoveryContext(handoff)).toEqual(expect.any(String))
    // Revisions at the original identity must invalidate the full-inventory proof.
    const saved = recovery.journal
      .snapshot()
      .items.find((item) => item.body.kind === 'message' && item.body.role === 'assistant')
    if (!saved) {
      throw new Error('Missing historical assistant')
    }
    const { parseAgentJournalItemKey } =
      await import('../../../shared/agent-session/journal/agent-session-journal-item-key')
    const identity = parseAgentJournalItemKey(saved.itemId)
    if (!identity) {
      throw new Error('Missing saved identity')
    }
    await recovery.journal.appendItem(
      identity,
      { ...hostTestMessage('Changed revision at the frozen cut'), role: 'assistant' },
      {
        fence: fixture.store.requireWritableRecord(SESSION).lease.runtimeFence,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      }
    )
    expect(await recovery.journal.exportRecoveryContext(handoff)).toBeUndefined()
    prepare.mockClear()
    const p = await fixture.accept('Use the frozen source')
    await eventually(async () =>
      expect((await fixture.submission(p))?.dispatchState).toBe('accepted')
    )
    prepare.mockClear()
    decode.mockClear()
    for (let ordinal = 0; ordinal < 4; ordinal++) {
      await recovery.journal.appendItem(
        { provider: 'codex', threadId: recovery.native(), turnId: 'stream', ordinal },
        { ...hostTestMessage('ordinary recovered output'), role: 'assistant' },
        {
          fence: fixture.store.requireWritableRecord(SESSION).lease.runtimeFence,
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        }
      )
    }
    expect(
      prepare.mock.calls.filter(([sql]) =>
        /agent_session_context_transfers|SELECT record_json FROM agent_session_records/.test(sql)
      )
    ).toEqual([])
    expect(decode).not.toHaveBeenCalled()
    decode.mockRestore()
    prepare.mockRestore()
  })
})
