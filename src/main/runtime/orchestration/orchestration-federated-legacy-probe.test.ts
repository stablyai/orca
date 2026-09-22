import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LEGACY_RUN_ID, OrchestrationDb } from './db'
import { federatedStubHomeRunId, SCHEMA_VERSION, UNBOUND_RUN_ID } from './db/contract-constants'
import { resolveOrchestrationMigrationStartVersion } from './orchestration-schema-version-skew'

describe('federated mailbox legacy-adoption probe', () => {
  let db: OrchestrationDb | undefined
  let directory: string | undefined

  afterEach(() => {
    db?.close()
    if (directory) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  function seedMailbox(
    handle: string,
    kind: 'message' | 'delivery',
    homeRunId = 'run_home',
    mailRunId = LEGACY_RUN_ID
  ): string {
    directory = mkdtempSync(join(tmpdir(), 'orca-federated-legacy-probe-'))
    const path = join(directory, 'orchestration.db')
    db = new OrchestrationDb(path)
    db.db
      .prepare(
        `INSERT INTO remote_dispatch_attachments (
           dispatch_id, task_id, home_peer_fingerprint, home_run_id, runtime_epoch, state
         ) VALUES ('ctx_remote', 'task_remote', 'peer_home', ?, 'epoch', 'ready')`
      )
      .run(homeRunId)
    if (kind === 'message') {
      db.db
        .prepare(
          `INSERT INTO messages (
             id, run_id, delivery_contract, from_handle, to_handle, subject, type
           ) VALUES ('msg_probe', ?, 'current_delivery', 'term_home', ?, 'continue', 'dispatch')`
        )
        .run(mailRunId, handle)
    } else {
      db.db
        .prepare(
          `INSERT INTO deliveries (id, run_id, mailbox_handle, consumer_generation, message_ids)
           VALUES ('delivery_probe', ?, ?, 0, '[]')`
        )
        .run(mailRunId, handle)
    }
    return path
  }

  it.each(['message', 'delivery'] as const)(
    'does not replay adoption for a misfiled federated %s',
    (kind) => {
      const path = seedMailbox('dispatch:ctx_remote', kind)
      expect(
        resolveOrchestrationMigrationStartVersion(db!.db, SCHEMA_VERSION, SCHEMA_VERSION)
      ).toBe(SCHEMA_VERSION)
      db!.close()
      db = new OrchestrationDb(path)
      expect(db.getLegacyAdoption()).toBeUndefined()
      if (kind === 'message') {
        expect(db.getMessageById('msg_probe')).toMatchObject({
          run_id: LEGACY_RUN_ID,
          delivery_contract: 'current_delivery'
        })
      } else {
        expect(
          db.db.prepare("SELECT status FROM deliveries WHERE id = 'delivery_probe'").get()
        ).toEqual({
          status: 'outstanding'
        })
      }
    }
  )

  it.each(['message', 'delivery'] as const)(
    'does not treat a stub-home-Run attachment %s as pre-Runs evidence',
    (kind) => {
      const stubRunId = federatedStubHomeRunId('ctx_remote')
      const path = seedMailbox('dispatch:ctx_remote', kind, stubRunId, stubRunId)
      db!.db
        .prepare(
          `INSERT INTO runs (id, objective, home_database, consumer_generation, legacy)
           VALUES (?, 'Coordinated from peer_home', 'remote', 0, 0)`
        )
        .run(stubRunId)
      expect(
        resolveOrchestrationMigrationStartVersion(db!.db, SCHEMA_VERSION, SCHEMA_VERSION)
      ).toBe(SCHEMA_VERSION)
      db!.close()
      db = new OrchestrationDb(path)
      expect(db.getLegacyAdoption()).toBeUndefined()
      expect(db.getRemoteDispatchAttachment('ctx_remote')?.home_run_id).toBe(stubRunId)
    }
  )

  it.each(['message', 'delivery'] as const)(
    'still replays adoption for a genuine legacy %s',
    (kind) => {
      const path = seedMailbox('term_legacy_coordinator', kind)
      expect(
        resolveOrchestrationMigrationStartVersion(db!.db, SCHEMA_VERSION, SCHEMA_VERSION)
      ).toBe(6)
      db!.close()
      db = new OrchestrationDb(path)
      expect(db.getLegacyAdoption()).toBeDefined()
      if (kind === 'message') {
        expect(db.getMessageById('msg_probe')).toMatchObject({
          run_id: db.getLegacyAdoption()!.adopted_run_id,
          delivery_contract: 'legacy_direct'
        })
      } else {
        expect(
          db.db.prepare("SELECT status FROM deliveries WHERE id = 'delivery_probe'").get()
        ).toEqual({
          status: 'fenced'
        })
      }
    }
  )

  it('keeps mail from a terminal in no Run across a reopen without replaying adoption', () => {
    directory = mkdtempSync(join(tmpdir(), 'orca-unbound-mail-probe-'))
    const path = join(directory, 'orchestration.db')
    db = new OrchestrationDb(path)
    const sent = db.insertMessage({ from: 'term_a', to: 'term_b', subject: 'hi' })
    expect(sent.run_id).toBe(UNBOUND_RUN_ID)
    expect(resolveOrchestrationMigrationStartVersion(db.db, SCHEMA_VERSION, SCHEMA_VERSION)).toBe(
      SCHEMA_VERSION
    )
    db.close()
    db = new OrchestrationDb(path)
    expect(db.getLegacyAdoption()).toBeUndefined()
    expect(db.getUnreadMessages('term_b').map((row) => row.id)).toEqual([sent.id])
  })
})
