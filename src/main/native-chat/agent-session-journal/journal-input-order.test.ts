import { journalInputIndexProbe } from './journal-input-index-probe.test-support'
import { JournalInputDomainIndex } from './journal-input-domain-index'
import { JournalInputPlaceIndex } from './journal-input-place-index'
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
  liveTestJournalRows,
  insertTestJournalRow
} from './journal-host-database-test-support'
import {
  selectedStructuredSubmission,
  selectStructuredAgentSessionInput
} from '../agent-session-wire/structured-agent-session-input-selection'

function knownPredecessors(owner: AgentSessionJournal | JournalReducerState, id: string): string[] {
  const state = 'queuedMessages' in owner ? owner.queuedMessages.displayState() : owner
  const submission = state.submissions.get(id)
  return submission
    ? [...state.queue.cards.values()]
        .filter((card) => state.inputOrder.precedes(card, submission))
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
  const message = (text: string): AgentJournalMessageItem => ({
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text }]
  })
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
      expect(knownPredecessors(journal, 'M')).toEqual(['C', 'D'])
      expect(journal.queuedMessages.get('C')?.state).toBe('withdrawn')
      expect(selectStructuredAgentSessionInput(journal)).toMatchObject({
        kind: 'card',
        card: { messageId: 'D' }
      })
    }
    await journal.close()
    const reopened = await journals.open({ identity, stateDirectory: root })
    expect(knownPredecessors(reopened, 'M')).toEqual(['C', 'D'])
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
    const message = (text: string): AgentJournalMessageItem => ({
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text }]
    })
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
      const rows = liveTestJournalRows(
        openTestJournalHostDatabase(root).db,
        identity.sessionId
      ).map((r) => JSON.parse(r.rowJson))
      expect(rows.find((r) => r.queueReopen === true)).toMatchObject({
        queueReopenSince: floor.sequence,
        seq: cursor.sequence - 1
      })
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
  const journals = createTrackedJournalOpener()
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
    const journals = createTrackedJournalOpener()
    const identity = {
      sessionId: 'domain',
      workspaceId: 'folder',
      hostId: 'ssh',
      agent: 'claude' as const,
      providerHandle: claudeProviderHandle('thread', null)
    }
    const message = (text: string): AgentJournalMessageItem => ({
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text }]
    })
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
              state.inputOrder.precedes(state.queue.cards.get(card)!, state.submissions.get(id)!)
            )
          ).toEqual(expected)
        }
        expect(['M1', 'M2', 'M3'].map((id) => state.inputOrder.forced(id))).toEqual([
          true,
          true,
          true
        ])
        expect(
          ['M1', 'M2', 'M3'].map((id) =>
            state.inputOrder.precedes(state.queue.cards.get('L')!, state.submissions.get(id)!)
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
  const message = (text: string): AgentJournalMessageItem => ({
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text }]
  })
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

it.each([10, 100])(
  'indexes the initial legacy writer shape without promoting foreign/null comparison N=%i',
  async (n) => {
    const root = await mkdtemp(join(tmpdir(), 'orca-legacy-baseline-'))
    const journals = createTrackedJournalOpener()
    const identity = {
      sessionId: 'baseline',
      workspaceId: 'folder',
      hostId: 'ssh',
      agent: 'claude' as const,
      providerHandle: claudeProviderHandle('thread', null)
    }
    const message = (text: string): AgentJournalMessageItem => ({
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text }]
    })
    let journal = await journals.open({ identity, stateDirectory: root })
    const database = openTestJournalHostDatabase(root)
    const cost = { sets: 0, queries: 0, nodes: 0, reads: 0 }
    const inspect = journalInputIndexProbe(['index', 'left', 'right'], {
      allocated: () => {
        cost.nodes++
      },
      read: () => {
        cost.reads++
      }
    })
    const set = JournalInputDomainIndex.prototype.set
    const domainSets = vi
      .spyOn(JournalInputDomainIndex.prototype, 'set')
      .mockImplementation(function (this: JournalInputDomainIndex, ...args) {
        cost.sets++
        inspect(this['root'])
        set.apply(this, args)
        inspect(this['root'])
      })
    const query = JournalInputDomainIndex.prototype.query
    const domainQueries = vi
      .spyOn(JournalInputDomainIndex.prototype, 'query')
      .mockImplementation(function (this: JournalInputDomainIndex, ...args) {
        cost.queries++
        return query.apply(this, args)
      })
    const indexSets = vi.spyOn(JournalInputPlaceIndex.prototype, 'set')
    try {
      const { epoch, sequence } = journal.cursor()
      let seq = sequence
      await journal.close()
      const base = () => ({ v: 3, epoch, seq: ++seq, fence: 0, ts: 1 })
      const queue = (
        id: string,
        queuedAt: { epoch: string; sequence: number } | null,
        command = false
      ) =>
        insertTestJournalRow(database.db, identity.sessionId, {
          ...base(),
          kind: 'queue',
          messageId: id,
          change: {
            op: 'queued',
            body: command ? { ...message('/compact'), command: { name: 'compact' } } : message(id),
            position: id === 'C' ? 1 : id === 'D' ? 2 : 3,
            queuedAt
          }
        })
      queue('C', { epoch, sequence: seq }, true)
      queue('F', { epoch: 'original-foreign', sequence: 1 })
      queue('N', null)
      database.transaction((db) => writeCommandReceiptTestRecord(db, identity.sessionId))
      const ids = Array.from({ length: n }, (_, i) => `M${i + 1}`)
      for (let i = 0; i < n; i++) {
        queue(`ordinary-${i}`, { epoch, sequence: seq })
      }
      queue('D', { epoch: 'original-foreign', sequence: 1 })
      for (const id of ids) {
        const target: JournalRow = {
          ...base(),
          kind: 'submission',
          clientMessageId: id,
          payloadFingerprint: id,
          body: message(id),
          providerHandle: agentSessionJournalProviderHandle(identity),
          handoverRecorded: true,
          origin: 'client'
        }
        insertTestJournalRow(database.db, identity.sessionId, target)
        if (id !== 'M2') {
          database.transaction((db) =>
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
                result: { kind: 'journal-row', epoch: 'original-foreign', sequence: 100 }
              }
            )
          )
        }
      }
      queue('later-F', { epoch: 'original-foreign', sequence: 1 })
      journal = await journals.open({ identity, stateDirectory: root })
      const check = (state: JournalReducerState) => {
        for (const card of ['F', 'D']) {
          expect(
            ['M1', 'M2', 'M3'].map((id) =>
              state.inputOrder.precedes(state.queue.cards.get(card)!, state.submissions.get(id)!)
            )
          ).toEqual([true, false, true])
        }
        for (const card of ['N', 'later-F']) {
          expect(
            ['M1', 'M2', 'M3'].map((id) =>
              state.inputOrder.precedes(state.queue.cards.get(card)!, state.submissions.get(id)!)
            )
          ).toEqual([false, false, false])
        }
        expect(['M1', 'M2', 'M3'].every((id) => state.inputOrder.forced(id))).toBe(true)
      }
      for (let pass = 0; pass < 3; pass++) {
        domainSets.mockClear()
        domainQueries.mockClear()
        indexSets.mockClear()
        if (pass) {
          await journal.replaceEpochItems('unreconcilable_prefix', 0, [])
        }
        check(journal.queuedMessages.displayState())
        const replay = loadTestJournal(root, identity.sessionId)!
        expect(replay.damage).toBeNull()
        check(replay.state)
        if (pass) {
          const rows = liveTestJournalRows(database.db, identity.sessionId).map((row) =>
            JSON.parse(row.rowJson)
          )
          expect(rows.length).toBeLessThanOrEqual(2 * n + 12)
          const baseline = journal.inputOrder
            .replacementLineage(
              new Set(journal.queuedMessages.list().map((card) => card.messageId))
            )
            .cards.filter((card) => card.baseline !== undefined).length
          expect(baseline).toBeLessThanOrEqual(n + 6)
          for (const id of ids) {
            journal.inputOrder.predecessors(journal.queuedMessages.displayState(), id)
            replay.state.inputOrder.predecessors(replay.state, id)
          }
          expect(domainQueries).toHaveBeenCalledTimes(2 * n)
          // Each independent fold adds at most one command-witness transition beyond the frozen baseline; each update traverses at most 54 introduction nodes.
          expect(domainSets.mock.calls.length).toBeLessThanOrEqual(4 * (n + 6) + 2 * rows.length)
          expect(indexSets.mock.calls.length).toBeLessThanOrEqual(
            54 * domainSets.mock.calls.length + 8 * rows.length
          )
          console.info(
            'legacy-normalized-output',
            JSON.stringify({
              n,
              pass,
              rows: rows.length,
              baseline,
              domainSets: domainSets.mock.calls.length,
              domainQueries: domainQueries.mock.calls.length,
              indexSets: indexSets.mock.calls.length
            })
          )
        }
      }
      domainSets.mockClear()
      domainQueries.mockClear()
      indexSets.mockClear()
      await holdUnsentSends(journal, { fence: 0, hold: { cause: 'hostRestarted' } })
      expect(domainQueries).toHaveBeenCalledTimes(n)
      // One finite-rank move per current card and one keep per input, each updating its one frozen coordinate through at most 54 introduction nodes.
      expect(domainSets.mock.calls.length).toBeLessThanOrEqual(16 * (n + 6))
      expect(indexSets.mock.calls.length).toBeLessThanOrEqual(
        54 * domainSets.mock.calls.length + 16 * (n + 6)
      )
      console.info(
        'legacy-recovery-index',
        JSON.stringify({
          n,
          domainSets: domainSets.mock.calls.length,
          domainQueries: domainQueries.mock.calls.length,
          indexSets: indexSets.mock.calls.length
        })
      )
      for (const id of ids) {
        expect(journal.submission(id)).toMatchObject({
          dispatchState: 'rejected',
          keptAsQueuedMessageId: id
        })
      }
      const ranks = journal.queuedMessages
        .list()
        .filter((card) => card.state === 'waiting')
        .map((card) => card.position)
      expect(
        ranks.every((rank, i) => Number.isFinite(rank) && (i === 0 || rank > ranks[i - 1]))
      ).toBe(true)
      // One point path allocates at most 54 nodes; point/prefix traversals read at most four fields per level.
      expect(cost.nodes).toBeLessThanOrEqual(54 * cost.sets)
      expect(cost.reads).toBeLessThanOrEqual(4 * 54 * (cost.sets + cost.queries))
      console.info('frozen-baseline-nodes', JSON.stringify({ n, ...cost }))
      expect(journal.inputOrder['cards']['domains']).toBeUndefined()
      expect(journal.inputOrder['places'].size).toBe(0)
      expect(journal.inputOrder['witnesses'].size).toBe(0)
      expect(
        [...journal.inputOrder.lineage.cards.values()].every((card) => card.baseline === undefined)
      ).toBe(true)
    } finally {
      domainSets.mockRestore()
      domainQueries.mockRestore()
      indexSets.mockRestore()
      await journals.closeAll()
      await rm(root, { recursive: true, force: true })
    }
  }
)
