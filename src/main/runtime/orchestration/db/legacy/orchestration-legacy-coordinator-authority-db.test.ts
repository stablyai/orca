import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'

import { OrchestrationDb } from '../orchestration-db'
import '../contract-constants'
import '../messages/mailbox-routing-page'
import '../dispatch-row-writer'
import '../attempt-outcome-projection'

import {
  createLegacyStorageCutoverFixture,
  type LegacyStorageCutoverFixture
} from './orchestration-legacy-storage-test-fixture'

describe('OrchestrationDb legacy coordinator authority', () => {
  let db: OrchestrationDb | undefined
  let tempDir: string | undefined

  afterEach(() => {
    db?.close()
    db = undefined
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
      tempDir = undefined
    }
  })

  function createCutoverFixture(): LegacyStorageCutoverFixture {
    const created = createLegacyStorageCutoverFixture()
    tempDir = created.tempDir
    return created.fixture
  }

  function openAdoptedFixture(): {
    fixture: LegacyStorageCutoverFixture
    adoptedRunId: string
  } {
    const fixture = createCutoverFixture()
    db = new OrchestrationDb(fixture.dbPath)
    const adoptedRunId = db.getLegacyAdoption()?.adopted_run_id as string
    db.commitLegacyCompatibilityPrincipal({
      runId: adoptedRunId,
      dispatchId: fixture.legacyDispatchId,
      role: 'worker',
      hostScope: 'local:runtime_1',
      terminalHandle: 'term_legacy_worker',
      paneKey: 'tab_legacy:33333333-3333-4333-8333-333333333333',
      launchTokenHash: 'legacy_launch_hash',
      processIncarnation: 'process_1'
    })
    return {
      fixture,
      adoptedRunId
    }
  }

  it('promotes only the unacknowledged coordinator recovery cohort during takeover', () => {
    const fixture = createCutoverFixture()
    db = new OrchestrationDb(fixture.dbPath)
    const adoptedRunId = db.getLegacyAdoption()?.adopted_run_id as string
    const unacknowledged = db.insertMessage({
      runId: adoptedRunId,
      deliveryContract: 'legacy_direct',
      from: 'term_legacy_worker',
      to: 'term_legacy_coord',
      subject: 'second recovered coordinator outcome'
    })
    db.markAsRead([unacknowledged.id])
    const coordinator = db.commitLegacyCompatibilityPrincipal({
      runId: adoptedRunId,
      role: 'coordinator',
      hostScope: 'local:runtime_1',
      terminalHandle: 'term_legacy_coord',
      paneKey: 'tab_coord:44444444-4444-4444-8444-444444444444',
      launchTokenHash: 'coord_launch_hash',
      processIncarnation: 'process_coord'
    }).principal
    const firstPage = db.getLegacyMailPage({ principalId: coordinator.id, limit: 1 })
    expect(firstPage.recovery).toBe(true)
    db.acknowledgeLegacyMail({
      principalId: coordinator.id,
      messageIds: firstPage.messages.map((message) => message.id)
    })
    const acknowledgedId = firstPage.messages[0].id

    db.bindRun({
      runId: adoptedRunId,
      coordinatorHandle: 'term_current_coord',
      coordinatorPaneKey: 'tab_current:11111111-1111-4111-8111-111111111111',
      takeoverLegacy: true
    })

    expect(db.getMessageById(acknowledgedId)).toMatchObject({
      to_handle: 'term_legacy_coord',
      delivery_contract: 'legacy_direct',
      read: 1
    })
    expect(db.getMessageById(unacknowledged.id)).toMatchObject({
      to_handle: `run:${adoptedRunId}`,
      delivery_contract: 'current_delivery',
      read: 0
    })
  })

  it('promotes a pre-cutover read recovery message when takeover precedes attestation', () => {
    const fixture = createCutoverFixture()
    db = new OrchestrationDb(fixture.dbPath)
    const adoptedRunId = db.getLegacyAdoption()?.adopted_run_id as string
    const recoveryMessageId = fixture.legacyMessageIds[1]
    expect(db.getLegacyCoordinatorPrincipal(adoptedRunId)).toBeUndefined()
    expect(db.getMessageById(recoveryMessageId)).toMatchObject({
      to_handle: 'term_legacy_coord',
      delivery_contract: 'legacy_direct',
      read: 1
    })

    const run = db.bindRun({
      runId: adoptedRunId,
      coordinatorHandle: 'term_current_coord',
      coordinatorPaneKey: 'tab_current:11111111-1111-4111-8111-111111111111',
      takeoverLegacy: true
    })!
    expect(db.getMessageById(recoveryMessageId)).toMatchObject({
      to_handle: `run:${adoptedRunId}`,
      delivery_contract: 'current_delivery',
      read: 0
    })

    const first = db.getOrCreateRunDelivery({
      runId: adoptedRunId,
      consumerGeneration: run.consumer_generation
    })!
    const replay = db.getOrCreateRunDelivery({
      runId: adoptedRunId,
      consumerGeneration: run.consumer_generation
    })!
    expect(first.messages.map((message) => message.id)).toContain(recoveryMessageId)
    expect(replay).toMatchObject({ replayed: true, delivery: { id: first.delivery.id } })

    db.acknowledgeRunDelivery({
      runId: adoptedRunId,
      consumerGeneration: run.consumer_generation,
      deliveryId: first.delivery.id
    })
    expect(
      db
        .getOrCreateRunDelivery({
          runId: adoptedRunId,
          consumerGeneration: run.consumer_generation
        })
        ?.messages.map((message) => message.id) ?? []
    ).not.toContain(recoveryMessageId)
  })

  it('promotes retained mail on an ordinary post-settlement coordinator replacement', () => {
    const state = openAdoptedFixture()
    const coordinator = db!.commitLegacyCompatibilityPrincipal({
      runId: state.adoptedRunId,
      role: 'coordinator',
      hostScope: 'local:runtime_1',
      terminalHandle: 'term_legacy_coord',
      paneKey: 'tab_coord:44444444-4444-4444-8444-444444444444',
      launchTokenHash: 'coord_launch_hash',
      processIncarnation: 'process_coord'
    }).principal
    const completion = db!.insertMessage({
      runId: state.adoptedRunId,
      deliveryContract: 'legacy_direct',
      from: 'term_legacy_worker',
      to: 'term_legacy_coord',
      subject: 'Completed before ordinary run-use',
      type: 'worker_done'
    })
    db!.settleWorkerReport({
      taskId: state.fixture.legacyTaskId,
      dispatchId: state.fixture.legacyDispatchId,
      outcome: 'succeeded',
      result: 'done'
    })

    const run = db!.bindRun({
      runId: state.adoptedRunId,
      coordinatorHandle: 'term_current_coord',
      coordinatorPaneKey: 'tab_current:11111111-1111-4111-8111-111111111111'
    })!

    expect(db!.getLegacyCompatibilityPrincipal(coordinator.id)?.status).toBe('revoked')
    expect(db!.getMessageById(completion.id)).toMatchObject({
      to_handle: `run:${state.adoptedRunId}`,
      delivery_contract: 'current_delivery',
      read: 0
    })
    expect(
      db!
        .getOrCreateRunDelivery({
          runId: state.adoptedRunId,
          consumerGeneration: run.consumer_generation
        })
        ?.messages.map((message) => message.id)
    ).toContain(completion.id)
  })
})
