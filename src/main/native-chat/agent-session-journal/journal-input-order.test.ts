import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { claudeProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
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
      expect(journal.inputOrder.prefix('M').map((card) => card.messageId)).toEqual(['C', 'D'])
      expect(journal.queuedMessages.get('C')?.state).toBe('withdrawn')
      expect(selectStructuredAgentSessionInput(journal)).toMatchObject({
        kind: 'card',
        card: { messageId: 'D' }
      })
    }
    await journal.close()
    const reopened = await journals.open({ identity, stateDirectory: root })
    expect(reopened.inputOrder.prefix('M').map((card) => card.messageId)).toEqual(['C', 'D'])
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
      expect(journal.inputOrder.prefix('M').map((c) => c.messageId)).toEqual(
        release === 'resume' ? ['C'] : []
      )
      if (release === 'accepted') {
        expect(journal.queuedMessages.pauses().map((p) => p.reason)).toEqual(['restarted'])
        await append('N')
        expect(journal.inputOrder.prefix('N')).toEqual([])
        await accept('N')
        expect(journal.queuedMessages.pauses()).toEqual([])
        await append('ordinary-held')
        // The accepted N released C; this later input genuinely belongs behind it.
        expect(journal.inputOrder.prefix('ordinary-held').map((c) => c.messageId)).toEqual(['C'])
      } else {
        expect(journal.queuedMessages.pauses()).toEqual([])
      }
      const beforePrefixes = ['forced', 'M', 'ordinary-held'].map((id) =>
        journal.inputOrder.prefix(id).map((c) => c.messageId)
      )
      const replay = loadTestJournal(root, identity.sessionId)!
      expect(replay.damage).toBeNull()
      expect(replay.newer).toBeNull()
      expect(
        ['forced', 'M', 'ordinary-held'].map((id) =>
          replay.state.inputOrder.prefix(id).map((c) => c.messageId)
        )
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
      expect(journal.inputOrder.prefix('new-epoch')).toEqual([])
      expect(
        ['forced', 'M', 'ordinary-held'].map((id) =>
          journal.inputOrder.prefix(id).map((c) => c.messageId)
        )
      ).toEqual(beforePrefixes)
      await journal.close()
      journal = await journals.open({ identity, stateDirectory: root })
      expect(
        ['forced', 'M', 'ordinary-held'].map((id) =>
          journal.inputOrder.prefix(id).map((c) => c.messageId)
        )
      ).toEqual(beforePrefixes)
      await accept('forced')
      expect(journal.inputOrder.prefix('forced')).toEqual([])
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
    expect(replay.state.inputOrder.prefix('M-after-replace')).toEqual(
      journal.inputOrder.prefix('M-after-replace')
    )
  } finally {
    await journals.closeAll()
    await rm(root, { recursive: true, force: true })
  }
})
