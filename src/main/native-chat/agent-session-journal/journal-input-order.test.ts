import { journalInputOrder } from './journal-input-order'
import { insertCommandReceiptIfAbsent, readCommandReceipt } from './command-receipt-table'
import { writeCommandReceiptTestRecord } from './command-receipt-test-support'
import type { JournalRow } from './journal-row-schema'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentSessionJournal } from './journal-store'
import type { JournalReducerState } from './journal-reducer'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import {
  agentSessionJournalProviderHandle,
  claudeProviderHandle
} from '../../../shared/agent-session-provider-handle-encoding'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import { holdUnsentSends } from './journal-unsent-send-hold'
import {
  createTrackedJournalOpener,
  loadTestJournal,
  openTestJournalHostDatabase,
  readTestJournalOutcomes,
  insertTestJournalRow
} from './journal-host-database-test-support'
import {
  selectedStructuredSubmission,
  selectStructuredAgentSessionInput
} from '../agent-session-wire/structured-agent-session-input-selection'

const message = (text: string): AgentJournalMessageItem => ({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text }]
})

function knownPredecessors(owner: AgentSessionJournal | JournalReducerState, id: string): string[] {
  const state = 'queuedMessages' in owner ? owner.queuedMessages.displayState() : owner
  const submission = state.submissions.get(id)
  return submission
    ? [...state.queue.cards.values()]
        .filter((card) => journalInputOrder(state).precedes(card, submission))
        .map((card) => card.messageId)
    : []
}

it('preserves the forced queue place through command removal, two epoch replacements, replay and recovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-input-order-'))
  const journals = createTrackedJournalOpener()
  const identity = {
    sessionId: 'order',
    workspaceId: 'folder',
    hostId: 'ssh',
    agent: 'claude' as const,
    providerHandle: claudeProviderHandle('thread', null)
  }
  const journal = await journals.open({ identity, stateDirectory: root })
  try {
    const c = await journal.queuedMessages.insert({
      messageId: 'C',
      body: { ...message('/compact'), command: { name: 'compact' } }
    })
    await journal.queuedMessages.insert({ messageId: 'D', body: message('earlier card') })
    await journal.appendSubmission({
      clientMessageId: 'M',
      body: message('stale direct'),
      payloadFingerprint: 'M',
      fence: 0,
      handoverRecorded: true,
      origin: 'client'
    })
    await journal.queuedMessages.insert({ messageId: 'later', body: message('later card') })
    await journal.queuedMessages.withdraw([c.messageId])
    expect(selectStructuredAgentSessionInput(journal)).toMatchObject({
      kind: 'card',
      card: { messageId: 'D' }
    })
    for (let round = 0; round < 2; round++) {
      await journal.replaceEpochItems('unreconcilable_prefix', 0, [])
      expect(knownPredecessors(journal, 'M')).toEqual(['D'])
      expect(journal.inputOrder.forced('M')).toBe(true)
      expect(journal.queuedMessages.get('C')).toBeNull()
      expect(selectStructuredAgentSessionInput(journal)).toMatchObject({
        kind: 'card',
        card: { messageId: 'D' }
      })
    }
    await journal.close()
    const reopened = await journals.open({ identity, stateDirectory: root })
    expect(knownPredecessors(reopened, 'M')).toEqual(['D'])
    expect(reopened.inputOrder.forced('M')).toBe(true)
    await holdUnsentSends(reopened, { fence: 0, hold: { cause: 'hostRestarted' } })
    expect(
      reopened.queuedMessages
        .list()
        .filter((card) => card.state === 'waiting')
        .map((card) => card.messageId)
    ).toEqual(['D', 'M', 'later'])
    expect(reopened.submission('M')).toMatchObject({
      dispatchState: 'rejected',
      keptAsQueuedMessageId: 'M'
    })
    expect(selectedStructuredSubmission(reopened)).toBeUndefined()
  } finally {
    await journals.closeAll()
    await rm(root, { recursive: true, force: true })
  }
})

it.each(['resume', 'accepted'] as const)(
  'preserves failed reopen admission facts across replay/replacement and %s release',
  async (release) => {
    const root = await mkdtemp(join(tmpdir(), 'orca-input-order-reopen-'))
    const journals = createTrackedJournalOpener()
    const identity = {
      sessionId: 'order',
      workspaceId: 'folder',
      hostId: 'ssh',
      agent: 'claude' as const,
      providerHandle: claudeProviderHandle('thread', null)
    }
    let journal = await journals.open({ identity, stateDirectory: root })
    const append = (
      id: string,
      receipt?: Parameters<typeof journal.appendSubmission>[2],
      fence = 1
    ) =>
      journal.appendSubmission(
        {
          clientMessageId: id,
          body: message(id),
          payloadFingerprint: id,
          fence,
          handoverRecorded: true,
          origin: 'client',
          options: { effort: 'high' }
        },
        undefined,
        receipt
      )
    const accept = (id: string) =>
      journal.resolveDispatch({
        clientMessageId: id,
        state: 'accepted',
        providerIdentity: null,
        fence: 1
      })
    try {
      await journal.queuedMessages.insert({
        messageId: 'C',
        body: { ...message('/compact'), command: { name: 'compact' } }
      })
      await append('forced')
      const mark = vi
        .spyOn(journal, 'appendQueueReopen')
        .mockRejectedValueOnce(new Error('disk full'))
      await expect(journal.markQueueReopen(1)).rejects.toThrow('disk full')
      mark.mockRestore()
      const floor = journal.reopenFloor()!
      const before = journal.cursor()
      let committed = 0
      await expect(
        append('M', {
          write: () => {
            throw new Error('receipt transaction fails')
          },
          committed: () => {
            committed++
          }
        })
      ).rejects.toThrow('receipt transaction fails')
      expect(journal.cursor()).toEqual(before)
      expect(journal.submission('M')).toBeUndefined()
      expect(journal.reopenFloor()).toEqual(floor)
      expect(
        loadTestJournal(root, identity.sessionId)!.state.queuePauseMarks.reopenedSequence
      ).toBe(0)
      expect(committed).toBe(0)
      await expect(append('stale', undefined, 0)).rejects.toMatchObject({
        code: 'journal_stale_fence'
      })
      expect(journal.cursor()).toEqual(before)
      expect(journal.reopenFloor()).toEqual(floor)
      if (release === 'resume') {
        await journal.appendQueueResume(1)
      }
      let target: { epoch: string; sequence: number } | undefined
      const cursor = await append('M', {
        write: (_db, row) => {
          if (row) {
            target = { epoch: row.epoch, sequence: row.seq }
          }
          expect(row).toMatchObject({
            kind: 'submission',
            clientMessageId: 'M',
            payloadFingerprint: 'M',
            options: { effort: 'high' },
            body: message('M')
          })
        },
        committed: () => {
          committed++
        }
      })
      expect(target).toEqual(cursor)
      expect(committed).toBe(1)
      expect(journal.reopenFloor()).toBeNull()
      const marks = readTestJournalOutcomes(
        openTestJournalHostDatabase(root).db,
        identity.sessionId
      ).filter((record) => record.field === '$' && record.key === '"queuePauseMarks"')
      expect(
        marks.some(
          (record) =>
            record.seq < cursor.sequence &&
            JSON.parse(record.json).reopenedSequence === floor.sequence
        )
      ).toBe(true)
      expect(knownPredecessors(journal, 'M')).toEqual(release === 'resume' ? ['C'] : [])
      if (release === 'accepted') {
        expect(journal.queuedMessages.pauses().map((p) => p.reason)).toEqual(['restarted'])
        await append('N')
        expect(knownPredecessors(journal, 'N')).toEqual([])
        await accept('N')
        expect(journal.queuedMessages.pauses()).toEqual([])
        await append('ordinary-held')
        // The accepted N released C; this later input genuinely belongs behind it.
        expect(knownPredecessors(journal, 'ordinary-held')).toEqual(['C'])
      } else {
        expect(journal.queuedMessages.pauses()).toEqual([])
      }
      const beforePrefixes = ['forced', 'M', 'ordinary-held'].map((id) =>
        knownPredecessors(journal, id)
      )
      const replay = loadTestJournal(root, identity.sessionId)!
      expect(replay.damage).toBeNull()
      expect(replay.newer).toBeNull()
      expect(
        ['forced', 'M', 'ordinary-held'].map((id) => knownPredecessors(replay.state, id))
      ).toEqual(beforePrefixes)
      const lateMark = vi
        .spyOn(journal, 'appendQueueReopen')
        .mockRejectedValueOnce(new Error('later reopen write fails'))
      await expect(journal.markQueueReopen(1)).rejects.toThrow('later reopen write fails')
      lateMark.mockRestore()
      const foreignFloor = journal.reopenFloor()!
      await journal.replaceEpochItems('unreconcilable_prefix', 1, [])
      expect(journal.reopenFloor()).toEqual(foreignFloor)
      expect(foreignFloor.epoch).not.toBe(journal.epoch)
      const beforeForeign = journal.cursor()
      await append('new-epoch')
      expect(journal.cursor().sequence).toBe(beforeForeign.sequence + 1)
      expect(knownPredecessors(journal, 'new-epoch')).toEqual([])
      expect(['forced', 'M', 'ordinary-held'].map((id) => knownPredecessors(journal, id))).toEqual(
        beforePrefixes
      )
      await journal.close()
      journal = await journals.open({ identity, stateDirectory: root })
      expect(['forced', 'M', 'ordinary-held'].map((id) => knownPredecessors(journal, id))).toEqual(
        beforePrefixes
      )
      await accept('forced')
      expect(knownPredecessors(journal, 'forced')).toEqual([])
    } finally {
      await journals.closeAll()
      await rm(root, { recursive: true, force: true })
    }
  }
)

it('keeps the receipt callback live after replacement of a legacy null-boundary card', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-input-replacement-'))
  const journals = createTrackedJournalOpener({ legacyInputs: true })
  const identity = {
    sessionId: 'null-order',
    workspaceId: 'folder',
    hostId: 'ssh',
    agent: 'claude' as const,
    providerHandle: claudeProviderHandle('thread', null)
  }
  const body: AgentJournalMessageItem = {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: '/compact' }],
    command: { name: 'compact' }
  }
  let journal = await journals.open({ identity, stateDirectory: root })
  try {
    const cursor = journal.cursor()
    await journal.close()
    insertTestJournalRow(openTestJournalHostDatabase(root).db, identity.sessionId, {
      v: 3,
      epoch: cursor.epoch,
      seq: cursor.sequence + 1,
      fence: 0,
      ts: 1,
      kind: 'queue',
      messageId: 'legacy-C',
      change: { op: 'queued', body, position: 1, queuedAt: null }
    })
    journal = await journals.open({ identity, stateDirectory: root })
    expect(journal.queuedMessages.get('legacy-C')?.queuedAt).toBeNull()
    await journal.replaceEpochItems('unreconcilable_prefix', 0, [])
    expect(journal.queuedMessages.get('legacy-C')?.queuedAt).toBeNull()
    await expect(
      journal.appendSubmission({
        clientMessageId: 'M-after-replace',
        body: { ...body, command: undefined },
        payloadFingerprint: 'M-after-replace',
        fence: 0,
        handoverRecorded: true,
        origin: 'client'
      })
    ).resolves.toMatchObject({ epoch: journal.epoch })
    expect(journal.submission('M-after-replace')).toMatchObject({ dispatchState: 'pending' })
    const replay = loadTestJournal(root, identity.sessionId)!
    expect(replay.damage).toBeNull()
    expect(replay.state.queue.cards.get('legacy-C')?.queuedAt).toBeNull()
    expect(knownPredecessors(replay.state, 'M-after-replace')).toEqual(
      knownPredecessors(journal, 'M-after-replace')
    )
  } finally {
    await journals.closeAll()
    await rm(root, { recursive: true, force: true })
  }
})

it.each(['legacy', 'observed'] as const)(
  'retains %s import evidence through two production replacements and replay',
  async (basis) => {
    const root = await mkdtemp(join(tmpdir(), 'orca-source-domain-'))
    const journals = createTrackedJournalOpener({ legacyInputs: true })
    const identity = {
      sessionId: 'domain',
      workspaceId: 'folder',
      hostId: 'ssh',
      agent: 'claude' as const,
      providerHandle: claudeProviderHandle('thread', null)
    }
    let journal = await journals.open({ identity, stateDirectory: root })
    const database = openTestJournalHostDatabase(root)
    try {
      const a = journal.cursor()
      await journal.close()
      let seq = a.sequence
      const row = (
        fields: Pick<Extract<JournalRow, { kind: 'queue' }>, 'kind' | 'messageId' | 'change'>
      ): JournalRow => ({ v: 3, epoch: a.epoch, seq: ++seq, fence: 0, ts: 1, ...fields })
      for (const [id, queuedAt] of [
        ['D', { epoch: 'foreign', sequence: 1 }],
        ['N', null],
        ['C', { epoch: a.epoch, sequence: seq }]
      ] as const) {
        insertTestJournalRow(
          database.db,
          identity.sessionId,
          row({
            kind: 'queue',
            messageId: id,
            change: {
              op: 'queued',
              body:
                id === 'C' ? { ...message('/compact'), command: { name: 'compact' } } : message(id),
              position: seq,
              queuedAt
            }
          })
        )
      }
      database.transaction((db) => writeCommandReceiptTestRecord(db, identity.sessionId))
      journal = await journals.open({ identity, stateDirectory: root })
      const originals = new Map<string, string>()
      for (const id of ['M1', 'M2', 'M3']) {
        const receipt =
          id === 'M2'
            ? undefined
            : {
                write: (
                  db: Parameters<typeof insertCommandReceiptIfAbsent>[0],
                  target?: JournalRow
                ) => {
                  expect(target).toMatchObject({ kind: 'submission', clientMessageId: id })
                  const result = {
                    kind: 'journal-row' as const,
                    epoch: target!.epoch,
                    sequence: target!.seq
                  }
                  insertCommandReceiptIfAbsent(
                    db,
                    { kind: 'global' },
                    {
                      operationId: id,
                      sessionId: identity.sessionId,
                      callerKey: 'fixture',
                      method: 'agentSession.send',
                      fingerprint: id,
                      status: 'accepted',
                      acceptedAt: 1,
                      result
                    }
                  )
                  originals.set(id, JSON.stringify(result))
                },
                committed: () => {}
              }
        if (basis === 'observed') {
          await journal.appendSubmission(
            {
              clientMessageId: id,
              payloadFingerprint: id,
              body: message(id),
              handoverRecorded: true,
              origin: 'client',
              options: { effort: 'high' },
              fence: 0
            },
            undefined,
            receipt
          )
        } else {
          await journal.close()
          const target: JournalRow = {
            kind: 'submission',
            v: 3,
            epoch: a.epoch,
            seq: journal.cursor().sequence + 1,
            ts: 1,
            fence: 0,
            clientMessageId: id,
            payloadFingerprint: id,
            body: message(id),
            providerHandle: agentSessionJournalProviderHandle(identity),
            handoverRecorded: true,
            origin: 'client',
            options: { effort: 'high' }
          }
          insertTestJournalRow(database.db, identity.sessionId, target)
          if (receipt) {
            database.transaction((db) => receipt.write(db, target))
          }
          journal = await journals.open({ identity, stateDirectory: root })
        }
      }
      const expected = basis === 'legacy' ? [true, false, true] : [true, true, true]
      const check = (state: JournalReducerState) => {
        for (const card of ['D', 'N']) {
          expect(
            ['M1', 'M2', 'M3'].map((id) =>
              journalInputOrder(state).precedes(
                state.queue.cards.get(card)!,
                state.submissions.get(id)!
              )
            )
          ).toEqual(expected)
        }
        expect(['M1', 'M2', 'M3'].map((id) => journalInputOrder(state).forced(id))).toEqual([
          true,
          true,
          true
        ])
        expect(
          ['M1', 'M2', 'M3'].map((id) =>
            journalInputOrder(state).precedes(
              state.queue.cards.get('L')!,
              state.submissions.get(id)!
            )
          )
        ).toEqual([false, false, false])
      }
      await journal.queuedMessages.insert({ messageId: 'L', body: message('later') })
      for (let pass = 0; pass < 3; pass++) {
        if (pass) {
          await journal.replaceEpochItems('unreconcilable_prefix', 0, [])
        }
        check(journal.queuedMessages.displayState())
        const replay = loadTestJournal(root, identity.sessionId)!
        expect(replay.damage).toBeNull()
        expect(replay.newer).toBeNull()
        check(replay.state)
        for (const id of ['M1', 'M3']) {
          expect(JSON.stringify(readCommandReceipt(database.db, { kind: 'global' }, id))).toContain(
            originals.get(id)!
          )
        }
        expect(readCommandReceipt(database.db, { kind: 'global' }, 'M2').verdict).toBe('absent')
        expect(journal.itemBody(agentJournalSubmissionKey('M2'))).toEqual(message('M2'))
        expect(journal.submission('M2')?.options).toEqual({ effort: 'high' })
      }
    } finally {
      await journals.closeAll()
      await rm(root, { recursive: true, force: true })
    }
  }
)

it('retries partial keeps from committed facts and carries rank moves on the first successful keep', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-partial-order-'))
  const journals = createTrackedJournalOpener()
  const identity = {
    sessionId: 'partial',
    workspaceId: 'folder',
    hostId: 'ssh',
    agent: 'claude' as const,
    providerHandle: claudeProviderHandle('thread', null)
  }
  let journal = await journals.open({ identity, stateDirectory: root })
  try {
    await journal.queuedMessages.insert({
      messageId: 'C',
      body: { ...message('/compact'), command: { name: 'compact' } }
    })
    await journal.queuedMessages.insert({ messageId: 'D', body: message('D') })
    for (const id of ['M1', 'M2']) {
      await journal.appendSubmission({
        clientMessageId: id,
        payloadFingerprint: id,
        body: message(id),
        handoverRecorded: true,
        origin: 'client',
        fence: 0
      })
    }
    await journal.queuedMessages.insert({ messageId: 'L', body: message('L') })
    await journal.close()
    journal = await journals.open({ identity, stateDirectory: root })
    const resolve = journal.resolveDispatch.bind(journal)
    const fault = vi
      .spyOn(journal, 'resolveDispatch')
      .mockImplementation((...args) =>
        args[0].clientMessageId === 'M1'
          ? Promise.reject(new Error('keep and fallback unavailable'))
          : resolve(...args)
      )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(
      holdUnsentSends(journal, { fence: 0, hold: { cause: 'hostRestarted' } })
    ).rejects.toThrow('settling unsent sends failed')
    expect(journal.submission('M1')?.dispatchState).toBe('pending')
    expect(journal.submission('M2')?.keptAsQueuedMessageId).toBe('M2')
    expect(journal.queuedMessages.get('L')?.position).toBeGreaterThan(
      journal.queuedMessages.get('M2')!.position
    )
    fault.mockRestore()
    warn.mockRestore()
    await holdUnsentSends(journal, { fence: 0, hold: { cause: 'hostRestarted' } })
    const saved = journal.queuedMessages.list().filter((card) => card.state === 'waiting')
    expect(saved.map((card) => card.messageId)).toEqual(['C', 'D', 'M1', 'M2', 'L'])
    expect(
      saved.every(
        (card, i) =>
          Number.isFinite(card.position) && (i === 0 || card.position > saved[i - 1].position)
      )
    ).toBe(true)
    await journal.close()
    journal = await journals.open({ identity, stateDirectory: root })
    await holdUnsentSends(journal, { fence: 0, hold: { cause: 'hostRestarted' } })
    expect(
      journal.queuedMessages
        .list()
        .filter((card) => card.state === 'waiting')
        .map((card) => card.messageId)
    ).toEqual(saved.map((card) => card.messageId))
  } finally {
    await journals.closeAll()
    await rm(root, { recursive: true, force: true })
  }
})
