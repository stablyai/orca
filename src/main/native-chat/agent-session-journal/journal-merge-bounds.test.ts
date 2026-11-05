import type {
  AgentSessionSubscribeEvent,
  AgentSessionStatusEvent
} from '../../../shared/agent-session/agent-session-wire'
import { finishJournalStepsAsync } from './journal-reconstruction-steps'
import { createQueuedMessageTestRig } from '../agent-session-wire/structured-agent-session-queued-message-rig.test-fixture'
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
import { prepareJournalOutcomeWrite } from './journal-outcome-write'
import { restoreJournalAsync } from './journal-open'
import { encodeJournalState } from './journal-state-codec'
import { JournalSqlOwner } from './journal-sql-owner'
import { countReconstructionWork } from './journal-reconstruction-work-test-support'
import type { JournalRow } from './journal-row-schema'

let root: string
const journals = createTrackedJournalOpener()
const rigs: Awaited<ReturnType<typeof createQueuedMessageTestRig>>[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const rig of rigs.splice(0)) {
    await rig.dispose()
  }
  await journals.closeAll()
  await closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

it('keeps logical replacement preparation finite and retained evidence reads paged at N and 10N', async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-merge-bounds-'))
  const totals: number[] = []
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
        inputOrderContext: {
          source: { epoch: projectionEpochRow.epoch, sequence: rows.length + 1 },
          basis: 'observed',
          cut: rows.length + 1
        },
        providerHandle: { kind: 'codex', threadId: 'thread-1' },
        payloadFingerprint: agentSessionSendBodyFingerprint(projectionSessionId, body)
      })
    }
    for (let index = 0; index < size; index++) {
      rows.push({
        ...projectionBase(rows.length + 1),
        kind: 'queue',
        messageId: `card-${index}`,
        change: {
          op: 'queued',
          body: {
            kind: 'message',
            role: 'user',
            blocks: [{ type: 'text', text: `card-${index}` }]
          },
          position: index,
          queuedAt: { epoch: projectionEpochRow.epoch, sequence: rows.length + 1 }
        }
      })
    }
    const turnIdentity = {
      provider: 'codex' as const,
      threadId: 'thread-1',
      turnId: 'replacement-turn',
      ordinal: 0
    }
    const turnBody = {
      kind: 'turn' as const,
      turnId: 'replacement-turn',
      state: 'running' as const,
      startedAt: 10_000
    }
    items.push({ identity: turnIdentity, body: turnBody, ownerFence: 1 })
    rows.push({
      ...projectionBase(rows.length + 1),
      kind: 'item',
      itemId: agentJournalItemKey(turnIdentity),
      revision: 1,
      body: turnBody
    })
    const oldIdentity = { provider: 'orca' as const, clientMessageId: 'old-only' }
    const newIdentity = { provider: 'orca' as const, clientMessageId: 'new-only' }
    rows.push({
      ...projectionBase(rows.length + 1),
      kind: 'item',
      itemId: agentJournalItemKey(oldIdentity),
      revision: 1,
      body: { kind: 'status', text: 'old' }
    })
    items.push({ identity: newIdentity, body: { kind: 'status', text: 'new' }, ownerFence: 1 })
    rows.push({
      ...projectionBase(rows.length + 1),
      kind: 'tombstone',
      itemId: agentJournalItemKey({ provider: 'orca', clientMessageId: 'stop' }),
      revision: 1,
      stopEvent: { reason: 'user-stop', at: 10_000 }
    })
    let seeded = seedOutcomeRows(database, [projectionEpochRow])
    for (let offset = 1; offset < rows.length; offset += 64) {
      seeded = database.fixtureTransaction((db) =>
        prepareJournalOutcomeWrite(db, seeded, rows.slice(offset, offset + 64), 10_000).adopt()
      )
    }
    const expected = encodeJournalState(seeded)
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
    await finishJournalStepsAsync(journal.inputOrder.markOpeningRecoverySteps())
    const peerView = peer.publicRead()
    const before = journal.publicRead()
    const oldSnapshot = before.snapshot
    const retainedSnapshot = structuredClone(oldSnapshot)
    const recovery = [...journal.inputOrder.recoverableSubmissionValues()].map((entry) => [
      entry.clientMessageId,
      journal.inputOrder.recoveryPending(entry.clientMessageId)
    ])
    const rig = await createQueuedMessageTestRig({ sessionId: projectionSessionId })
    rigs.push(rig)
    await rig.workingSend()
    const sessions = rig.host.collaboratorsForTests().sessions
    sessions.set(projectionSessionId, { ...sessions.get(projectionSessionId)!, journal })
    const frames: AgentSessionSubscribeEvent[] = []
    const delivered = Promise.withResolvers<void>()
    let replacing = false
    const releaseChat = await rig.host.subscribe({
      id: 'live-chat',
      sessionId: projectionSessionId,
      readsCurrentRequests: true,
      emit: (event) => {
        frames.push(event)
        if (
          replacing &&
          (event.type === 'reset' || event.type === 'snapshot') &&
          event.page.epoch !== retainedSnapshot.cursor.epoch
        ) {
          delivered.resolve()
        }
      }
    })
    const reconnects: Promise<() => void>[] = []
    const concurrentReads: Promise<unknown>[] = []
    const reconnected = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
    const statuses: AgentSessionStatusEvent[] = []
    let releaseStatus = () => {}
    let publicationCount = 0
    const releasePublication = sessions.observeConversationPublications(projectionSessionId, {
      next: (hint) => {
        if (hint.kind === 'commit') {
          publicationCount++
        }
      },
      error: (error) => {
        throw error
      }
    })
    const settle = journal.stopMarks.beginSettle(true)
    await new Promise<void>((resolve) => setImmediate(resolve))
    const conversation = rig.store.getConversation.bind(rig.store)
    let releasedLease = false
    const leaseRead = vi.spyOn(rig.store, 'getConversation').mockImplementation((id) => {
      const record = conversation(id)
      return releasedLease && record?.ownerObservation
        ? { ...record, ownerObservation: { ...record.ownerObservation, claimStatus: 'released' } }
        : record
    })
    let projectingStatus = false
    let changedEvidence = false
    const statusSteps = journal.statusReadSteps.bind(journal)
    const statusPreparation = vi.spyOn(journal, 'statusReadSteps').mockImplementation(function* () {
      projectingStatus = true
      try {
        return yield* statusSteps()
      } finally {
        projectingStatus = false
      }
    })
    let oldReads = 0
    let newReads = 0
    let peerReads = 0
    const work = await countReconstructionWork(
      async () => {
        replacing = true
        const result = await journal.replaceEpochItems('handle_forked', 1, items)
        await delivered.promise
        await Promise.all(reconnected.map((entry) => entry.promise))
        await Promise.all(concurrentReads)
        await journal.readInOrder(() => {})
        return result
      },
      () => {
        if (peer.publicRead() !== peerView) {
          throw new Error('unrelated chat changed')
        }
        peerReads++
        if (projectingStatus && !changedEvidence) {
          changedEvidence = true
          for (const [index, cursor] of [undefined, retainedSnapshot.cursor].entries()) {
            reconnects.push(
              rig.host.subscribe({
                id: `during-refresh-${index}`,
                sessionId: projectionSessionId,
                ...(cursor ? { cursor } : {}),
                readsCurrentRequests: true,
                emit: (event) => {
                  frames.push(event)
                  if (
                    (event.type === 'snapshot' || event.type === 'reset') &&
                    event.page.epoch === journal.cursor().epoch
                  ) {
                    reconnected[index].resolve()
                  }
                }
              })
            )
          }
          concurrentReads.push(
            rig.host.journalCurrentRead(projectionSessionId),
            rig.host.journalSnapshot(projectionSessionId),
            rig.host.readCurrentRequests({
              sessionId: projectionSessionId,
              version: 'before-refresh'
            }),
            rig.host.history({ sessionId: projectionSessionId, direction: 'tail' }),
            rig.host.history({
              sessionId: projectionSessionId,
              direction: 'before',
              cursor: retainedSnapshot.cursor
            })
          )
          rig.host['clientDelivery'].readStopping(projectionSessionId)
          releaseStatus = rig.host.subscribeStatus({
            id: 'reconnecting-status',
            emit: (event) => statuses.push(event)
          })
          releasedLease = true
          journal.stopMarks.settled(settle)
          const session = sessions.get(projectionSessionId)!
          session.operationalRevision = (session.operationalRevision ?? 0) + 1
        }
        const old = journal.item(agentJournalItemKey(oldIdentity))
        const fresh = journal.item(agentJournalItemKey(newIdentity))
        if (old && !fresh) {
          oldReads++
        } else if (!old && fresh) {
          newReads++
        } else {
          throw new Error('replacement exposed mixed history')
        }
      }
    )
    statusPreparation.mockRestore()
    expect(changedEvidence).toBe(true)
    expect(frames.some((event) => event.type === 'reset' || event.type === 'snapshot')).toBe(true)
    expect(
      statuses.some((event) => event.type === 'status' && event.session.status === 'idle')
    ).toBe(true)
    expect(rig.host['clientDelivery'].readStatusSummary(projectionSessionId)?.status).toBe('idle')
    leaseRead.mockRestore()
    expect(work.maximum, work.site).toBeLessThanOrEqual(65_536)
    totals.push(work.total)
    expect(work.total).toBeLessThanOrEqual(size * 4096)
    expect(peerReads).toBeGreaterThan(0)
    expect(oldReads).toBeGreaterThan(0)
    expect(publicationCount).toBe(1)
    expect(oldSnapshot).toEqual(retainedSnapshot)
    expect(before.snapshot).toEqual(retainedSnapshot)
    expect(
      [...journal.inputOrder.recoverableSubmissionValues()].map((entry) => [
        entry.clientMessageId,
        journal.inputOrder.recoveryPending(entry.clientMessageId)
      ])
    ).toEqual(recovery)
    expect(journal.queuedMessages.list().map((card) => card.messageId)).toEqual(
      Array.from({ length: size }, (_, index) => `card-${index}`)
    )
    expect(journal.publicRead()).not.toBe(before)
    expect(journal.snapshot().items.map((item) => item.itemId)).toEqual(
      items.map((item) => agentJournalItemKey(item.identity))
    )
    for (const release of await Promise.all(reconnects)) {
      release()
    }
    releaseStatus()
    releaseChat()
    releasePublication()
    sessions.delete(projectionSessionId)
    const published = journal.snapshot()
    const reopened = await journals.open({
      stateDirectory: database.stateDirectory,
      identity: {
        sessionId: projectionSessionId,
        workspaceId: 'ws',
        hostId: 'local',
        agent: 'codex',
        providerHandle: codexProviderHandle('thread-1')
      }
    })
    expect(reopened.snapshot()).toEqual(published)
    expect(reopened.queuedMessages.list()).toEqual(journal.queuedMessages.list())
    expect(work.result).toEqual(journal.cursor())
    process.stdout.write(
      `merge bounds population=${size} nativeEvidenceRequests=${requests} maximumHostWork=${work.maximum} yields=${work.yields} totalHostWork=${work.total} oldReads=${oldReads} newReads=${newReads}\n`
    )
  }
  expect(totals[1]).toBeLessThanOrEqual(totals[0] * 14)
})
