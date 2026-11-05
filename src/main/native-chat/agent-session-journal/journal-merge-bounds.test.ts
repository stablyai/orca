import type { JournalReplacementItem } from './journal-epoch-replacement'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { agentSessionSendBodyFingerprint } from '../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import {
  createTrackedJournalOpener,
  openTestJournalHostDatabase,
  closeTestJournalHostDatabases
} from './journal-host-database-test-support'
import {
  projectionBase,
  projectionEpochRow,
  projectionSessionId,
  seedOutcomeRows
} from './journal-projection-test-support'
import { restoreJournalAsync } from './journal-open'
import { encodeJournalState } from './journal-state-codec'
import { JournalWriteProjection } from './journal-write-projection'
import { JournalSqlOwner } from './journal-sql-owner'
import { countReconstructionWork } from './journal-reconstruction-work-test-support'
import type { JournalRow } from './journal-row-schema'

let root: string
const journals = createTrackedJournalOpener()
afterEach(async () => {
  vi.restoreAllMocks()
  await journals.closeAll()
  await closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

it('keeps logical replacement preparation finite and retained evidence reads paged at N and 10N', async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-merge-bounds-'))
  for (const size of [256, 2560]) {
    const database = await openTestJournalHostDatabase(join(root, String(size)))
    const rows: JournalRow[] = [projectionEpochRow]
    const items: JournalReplacementItem[] = []
    for (let index = 0; index < size; index++) {
      const id = `send-${index}`
      const body: AgentJournalMessageItem = {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: id }]
      }
      const identity = { provider: 'orca' as const, clientMessageId: id }
      items.push({ identity, body, ownerFence: 1 })
      rows.push({
        ...projectionBase(rows.length + 1),
        kind: 'submission',
        clientMessageId: id,
        body,
        handoverRecorded: true,
        providerHandle: { kind: 'codex', threadId: 'thread-1' },
        payloadFingerprint: agentSessionSendBodyFingerprint(projectionSessionId, body)
      })
    }
    const expected = encodeJournalState(seedOutcomeRows(database, rows))
    let requests = 0
    const request = JournalSqlOwner.prototype.request
    const spy = vi.spyOn(JournalSqlOwner.prototype, 'request').mockImplementation(function (
      this: JournalSqlOwner,
      command
    ) {
      if (command.type === 'read') {
        requests++
      }
      return request.call(this, command)
    })
    const restored = await database.read((read) => restoreJournalAsync(read, projectionSessionId))
    spy.mockRestore()
    expect(restored?.damage).toBeNull()
    expect(restored && encodeJournalState(restored.state)).toEqual(expected)
    expect(requests).toBeLessThanOrEqual(Math.ceil(size / 4) + 32)

    const journal = await journals.open({
      stateDirectory: database.stateDirectory,
      identity: {
        sessionId: projectionSessionId,
        workspaceId: 'ws',
        hostId: 'local',
        agent: 'codex',
        providerHandle: codexProviderHandle('thread-1')
      }
    })
    const peer = await journals.open({
      stateDirectory: database.stateDirectory,
      identity: {
        sessionId: `peer-${size}`,
        workspaceId: 'ws',
        hostId: 'local',
        agent: 'codex',
        providerHandle: codexProviderHandle('peer')
      }
    })
    const peerView = peer.publicRead()
    const before = journal.publicRead()
    let peerReads = 0
    const preparation = Promise.withResolvers<void>()
    const prepare = JournalWriteProjection.prototype.prepare
    const preparing = vi
      .spyOn(JournalWriteProjection.prototype, 'prepare')
      .mockImplementation(function (this: JournalWriteProjection, ...args) {
        preparation.resolve()
        return prepare.apply(this, args)
      })
    let replacement: Promise<unknown> | undefined
    // Measure through row materialization, before the projection's separate fold/adoption path.
    const work = await countReconstructionWork(
      async () => {
        replacement = journal.replaceEpochItems('handle_forked', 1, items)
        await Promise.race([preparation.promise, replacement])
      },
      () => {
        if (peer.publicRead() !== peerView) {
          throw new Error('unrelated chat changed')
        }
        peerReads++
      }
    )
    preparing.mockRestore()
    await replacement
    expect(work.maximum, work.site).toBeLessThanOrEqual(65_536)
    expect(peerReads).toBeGreaterThan(0)
    expect(journal.publicRead()).not.toBe(before)
    expect(journal.snapshot().items.map((item) => item.itemId)).toEqual(
      items.map((item) => agentJournalItemKey(item.identity))
    )
    process.stdout.write(
      `merge bounds population=${size} nativeEvidenceRequests=${requests} maximumHostWork=${work.maximum} yields=${work.yields}\n`
    )
  }
})
