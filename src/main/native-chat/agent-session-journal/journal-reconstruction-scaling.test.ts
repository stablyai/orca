import {
  seedLinkedLegacyReconstruction,
  verifyInputOnlyCleanup
} from './journal-reconstruction-test-fixture'
import { JournalGoalAttachmentInverse } from './journal-goal-attachment-inverse'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import {
  agentJournalItemKey,
  parseAgentJournalItemKey
} from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalMessageItem
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import {
  createTrackedJournalOpener,
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase,
  insertTestJournalRow,
  publishTestJournalEpoch
} from './journal-host-database-test-support'
import {
  projectionBase,
  projectionEpochRow,
  projectionEpoch,
  projectionSessionId,
  seedOutcomeRows
} from './journal-projection-test-support'
import { restoreJournal } from './journal-open'
import { restoreJournalAsync } from './journal-async-open'
import type { JournalReplacementItem } from './journal-epoch-replacement'
import { encodeJournalState } from './journal-state-codec'
import { renderJournalState } from './journal-reducer'
import type { JournalRow } from './journal-row-schema'
import type * as Steps from './journal-reconstruction-steps'
import type * as TurnTree from './journal-newest-turn-tree'
import { JournalNewestTurn } from './journal-newest-turn'
import { agentSessionFailureFact } from '../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session/failures/agent-session-failure-words'
import { JournalInputPlaceIndex } from './journal-input-place-index'
import { journalInputOrder } from './journal-input-order-owner'
import { JournalPersistencePlan } from './journal-persistence-plan'
import {
  countReconstructionWork,
  reconstructionWork
} from './journal-reconstruction-work-test-support'

vi.mock('./journal-reconstruction-steps', async (original) => {
  const actual = await original<typeof Steps>()
  const work = await import('./journal-reconstruction-work-test-support')
  return {
    ...actual,
    sortJournalSteps: function* <T>(values: Iterable<T>, compare: (a: T, b: T) => number) {
      return yield* actual.sortJournalSteps(values, (a, b) => {
        work.reconstructionWork.visit()
        return compare(a, b)
      })
    }
  }
})

vi.mock('./journal-newest-turn-tree', async (original) => {
  const actual = await original<typeof TurnTree>()
  const work = await import('./journal-reconstruction-work-test-support')
  return {
    ...actual,
    putTurnSourceSteps: function* (...args: Parameters<typeof actual.putTurnSourceSteps>) {
      const steps = actual.putTurnSourceSteps(...args)
      for (;;) {
        const next = steps.next()
        work.reconstructionWork.visit()
        if (next.done) {
          return next.value
        }
        yield next.value
      }
    }
  }
})

let root: string
const journals = createTrackedJournalOpener()
afterEach(async () => {
  vi.restoreAllMocks()
  await journals.closeAll()
  await closeTestJournalHostDatabases()
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
})

const body = (id: string): AgentJournalMessageItem => ({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: id }]
})

function population(size: number): JournalRow[] {
  const rows: JournalRow[] = [projectionEpochRow]
  for (let index = 0; index < size; index++) {
    const turnItemId = agentJournalItemKey({
      provider: 'orca',
      clientMessageId: `status-${index - (index % 2)}`
    })
    rows.push({
      ...projectionBase(rows.length + 1),
      kind: 'item',
      itemId: agentJournalItemKey({ provider: 'orca', clientMessageId: `status-${index}` }),
      revision: 1,
      body:
        index % 2 === 0
          ? { kind: 'turn', turnId: `turn-${index}`, state: 'completed', outcome: 'failure' }
          : {
              kind: 'status',
              ...agentSessionFailureWords(agentSessionFailureFact('usageLimitReached'), {
                surface: 'row'
              })
            },
      turnScope: index % 2 === 0 ? AGENT_JOURNAL_THREAD_SCOPE : { kind: 'turn', turnItemId }
    })
  }
  for (let index = 0; index < size; index++) {
    const seq = rows.length + 1
    rows.push({
      ...projectionBase(seq),
      kind: 'submission',
      clientMessageId: `send-${index}`,
      body: body(`send-${index}`),
      providerHandle: { kind: 'codex', threadId: 'thread-1' },
      payloadFingerprint: `fingerprint-${index}`,
      handoverRecorded: true,
      origin: 'client',
      inputOrderContext: {
        source: { epoch: projectionEpoch, sequence: seq },
        basis: 'observed',
        cut: seq
      }
    })
  }
  for (let index = 0; index < size; index++) {
    rows.push({
      ...projectionBase(rows.length + 1),
      kind: 'queue',
      messageId: `card-${index}`,
      change: {
        op: 'queued',
        position: index,
        body: body(`card-${index}`),
        queuedAt: { epoch: projectionEpoch, sequence: index + 2 }
      }
    })
  }
  return rows
}

const fixtures: {
  size: number
  database: Awaited<ReturnType<typeof openTestJournalHostDatabase>>
  inputOnly: Awaited<ReturnType<typeof openTestJournalHostDatabase>>
  previous: ReturnType<typeof seedOutcomeRows>
  expected: ReturnType<typeof encodeJournalState>
  linkedDatabase: Awaited<ReturnType<typeof seedLinkedLegacyReconstruction>>
  linkedExpected: ReturnType<typeof restoreJournal>
}[] = []
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-reconstruction-scaling-'))
  for (const size of [256, 2_560]) {
    const started = performance.now()
    const phase = (name: string): void => {
      process.stdout.write(
        `setup population=${size} phase=${name} elapsedMs=${Math.round(performance.now() - started)}\n`
      )
    }
    phase('native-open')
    const database = await openTestJournalHostDatabase(join(root, `native-${size}`))
    phase('outcome-seed')
    const rows = population(size)
    const previous = seedOutcomeRows(database, rows)
    const expected = encodeJournalState(previous)
    phase('input-open')
    const inputOnly = await openTestJournalHostDatabase(join(root, `input-${size}`))
    phase('input-seed')
    inputOnly.fixtureTransaction((db) => {
      publishTestJournalEpoch(db, projectionSessionId, projectionEpoch)
      for (const row of rows) {
        insertTestJournalRow(db, projectionSessionId, row)
      }
    })
    phase('linked-seed')
    const linkedDatabase = await seedLinkedLegacyReconstruction(root, size)
    phase('linked-restore')
    const linkedExpected = restoreJournal(linkedDatabase.db, projectionSessionId)
    fixtures.push({ size, database, inputOnly, previous, expected, linkedDatabase, linkedExpected })
    phase('complete')
  }
})

it('bounds private restore and epoch reconstruction work through finalization', async () => {
  await verifyInputOnlyCleanup(root)
  const indexSteps = JournalInputPlaceIndex.prototype.setSteps
  vi.spyOn(JournalInputPlaceIndex.prototype, 'setSteps').mockImplementation(function* (
    this: JournalInputPlaceIndex,
    ...args
  ) {
    for (const step of indexSteps.apply(this, args)) {
      reconstructionWork.visit()
      yield step
    }
  })
  for (const {
    size,
    database,
    inputOnly,
    previous,
    expected,
    linkedDatabase,
    linkedExpected
  } of fixtures) {
    const peer = await journals.open({
      stateDirectory: database.stateDirectory,
      identity: {
        sessionId: `peer-${size}`,
        workspaceId: 'workspace',
        hostId: 'local',
        agent: 'codex',
        providerHandle: codexProviderHandle('peer')
      }
    })
    const peerView = peer.publicRead()
    let peerReads = 0
    const readPeer = () => {
      if (peer.publicRead() !== peerView) {
        throw new Error('peer view changed')
      }
      peerReads++
    }
    process.stdout.write(`phase population=${size} start=restored\n`)
    const restored = await countReconstructionWork(
      () => database.read((read) => restoreJournalAsync(read, projectionSessionId)),
      readPeer
    )
    expect(restored.result?.damage).toBeNull()
    expect(restored.result?.newer).toBeNull()
    expect(restored.result && encodeJournalState(restored.result.state)).toEqual(expected)
    const newest = new JournalNewestTurn(previous)
    expect(newest.read()).not.toBeNull()
    expect(newest.failure()).toBe(previous.lastSequence)
    expect(restored.result && journalInputOrder(restored.result.state).newestTurn.read()).toEqual(
      newest.read()
    )
    expect(restored.result && journalInputOrder(restored.result.state).newestTurn.failure()).toBe(
      newest.failure()
    )
    process.stdout.write(`phase population=${size} start=legacy\n`)
    const legacy = await countReconstructionWork(
      () => inputOnly.read((read) => restoreJournalAsync(read, projectionSessionId)),
      readPeer
    )
    expect(legacy.result?.damage).toBeNull()
    expect(legacy.result?.newer).toBeNull()
    expect(legacy.result && encodeJournalState(legacy.result.state)).toEqual(expected)

    process.stdout.write(`phase population=${size} start=linked\n`)
    const linked = await countReconstructionWork(
      () => linkedDatabase.read((read) => restoreJournalAsync(read, projectionSessionId)),
      readPeer
    )
    expect(linked.result?.damage).toBeNull()
    expect(linked.result?.newer).toBeNull()
    expect(linked.result && encodeJournalState(linked.result.state)).toEqual(
      linkedExpected && encodeJournalState(linkedExpected.state)
    )
    expect(
      linked.result && [...journalInputOrder(linked.result.state).linkedTo('legacy')].length
    ).toBe(size)
    expect(linked.result && journalInputOrder(linked.result.state).cards.hasOverlay('legacy')).toBe(
      true
    )

    const items: JournalReplacementItem[] = [...previous.items.values()].map((item) => {
      const identity = parseAgentJournalItemKey(item.itemId)
      if (!identity) {
        throw new Error('fixture identity missing')
      }
      return { identity, body: item.body, ownerFence: 1, turnScope: item.turnScope }
    })
    process.stdout.write(`phase population=${size} start=opened\n`)
    const opened = await countReconstructionWork(
      () =>
        journals.open({
          stateDirectory: database.stateDirectory,
          identity: {
            sessionId: projectionSessionId,
            workspaceId: 'workspace',
            hostId: 'local',
            agent: 'codex',
            providerHandle: codexProviderHandle('thread-1')
          },
          mintEpoch: () => 'store-replacement'
        }),
      readPeer
    )
    for (let index = 0; index < size; index++) {
      expect(opened.result.inputOrder.recoveryPending(`send-${index}`)).toBe(true)
    }
    const storePhases: string[] = []
    const stop = opened.result.observeCommits(() => storePhases.push('publish'))
    let claimsPlanned = 0,
      claimsSettled = 0,
      claimsCommitted = 0
    const add = JournalPersistencePlan.prototype.add
    const added = vi.spyOn(JournalPersistencePlan.prototype, 'add').mockImplementation(function (
      this: JournalPersistencePlan,
      effect,
      result
    ) {
      if (effect.kind !== 'claim') {
        return add.call(this, effect, result)
      }
      claimsPlanned++
      return add.call(this, effect, (value) => {
        if (
          typeof value !== 'object' ||
          !value ||
          !('referenced' in value) ||
          value.referenced.size !== 0 ||
          value.inserted.length !== 0 ||
          opened.result.epoch !== projectionEpoch
        ) {
          throw new Error('claim result or settlement phase changed')
        }
        claimsSettled++
        result?.(value)
      })
    })
    const acquire = JournalGoalAttachmentInverse.prototype.acquired
    const acquired = vi
      .spyOn(JournalGoalAttachmentInverse.prototype, 'acquired')
      .mockImplementation(function (this: JournalGoalAttachmentInverse, ...args) {
        if (opened.result.epoch !== 'store-replacement') {
          throw new Error('claim committed before adoption')
        }
        claimsCommitted++
        return acquire.apply(this, args)
      })
    process.stdout.write(`phase population=${size} start=storeReplacement\n`)
    const storeReplacement = await countReconstructionWork(
      () =>
        opened.result.replaceEpochItems('handle_forked', 1, items, () => ({
          write: (plan) => {
            if (
              plan.preparedState?.items.size !== previous.items.size ||
              opened.result.epoch !== projectionEpoch
            ) {
              throw new Error('store exposed incomplete preparation')
            }
            storePhases.push('write')
          },
          committed: () => {
            if (opened.result.epoch !== 'store-replacement' || claimsCommitted !== 3 * size) {
              throw new Error('store receipt preceded adoption or claims')
            }
            storePhases.push('committed')
          }
        })),
      () => {
        readPeer()
        if (
          opened.result.epoch !== projectionEpoch &&
          opened.result.epoch !== 'store-replacement'
        ) {
          throw new Error('store exposed incomplete epoch')
        }
      }
    )
    process.stdout.write(
      `phase population=${size} completed=storeReplacement max=${storeReplacement.maximum}\n`
    )
    stop()
    acquired.mockRestore()
    added.mockRestore()
    expect(claimsPlanned).toBe(3 * size)
    expect(claimsSettled).toBe(claimsPlanned)
    expect(claimsCommitted).toBe(claimsPlanned)
    expect(storePhases).toEqual(['write', 'committed', 'publish'])
    const storeReloaded = restoreJournal(database.db, projectionSessionId)
    expect(storeReloaded?.damage).toBeNull()
    expect(opened.result.publicRead().snapshot).toEqual(
      storeReloaded && renderJournalState(storeReloaded.state)
    )
    expect(
      JSON.stringify(encodeJournalState(opened.result.queuedMessages.displayState())) ===
        JSON.stringify(storeReloaded && encodeJournalState(storeReloaded.state)),
      'exact published and persisted canonical state'
    ).toBe(true)
    expect(
      JSON.stringify(
        renderJournalState(opened.result.queuedMessages.displayState()).items.map((item) => [
          item.itemId,
          item.body
        ])
      ) ===
        JSON.stringify(renderJournalState(previous).items.map((item) => [item.itemId, item.body])),
      'exact retained item order and bodies'
    ).toBe(true)
    for (let index = 0; index < size; index++) {
      expect(opened.result.inputOrder.recoveryPending(`send-${index}`)).toBe(true)
    }
    expect(peerReads).toBeGreaterThan(0)
    for (const work of [storeReplacement]) {
      expect(work.maxUploadPackets).toBeLessThanOrEqual(128)
      // Ordinary short claim effects share staging ACKs instead of paying one round trip each.
      expect(work.uploads).toBeLessThanOrEqual(Math.ceil(size / 4))
    }
    for (const work of [restored, legacy, linked, opened, storeReplacement]) {
      expect(work.yields).toBeGreaterThan(0)
      expect(work.total).toBeGreaterThan(size)
      // Same ordinary-operation budget at both populations; no latency or indivisible-value claim.
      expect(work.maximum, work.site).toBeLessThanOrEqual(65_536)
    }
    process.stdout.write(
      `${JSON.stringify({
        population: size,
        phases: [restored, legacy, linked, opened, storeReplacement].map(
          ({ maximum, yields, total, uploads, maxUploadPackets }) => ({
            maximum,
            yields,
            total,
            uploads,
            maxUploadPackets
          })
        ),
        claimsPlanned,
        claimsSettled,
        claimsCommitted
      })}\n`
    )
  }
})
