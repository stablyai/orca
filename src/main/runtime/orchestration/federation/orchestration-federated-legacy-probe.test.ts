import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../db/orchestration-db'
import { SCHEMA_VERSION } from '../db/contract-constants'
import '../db/messages/mailbox-routing-page'
import '../db/dispatch-row-writer'
import '../db/attempt-outcome-projection'
import { ORCHESTRATION_UNBOUND_RUN_ID as UNBOUND_RUN_ID } from '../../../../shared/orchestration-rpc-contract'

import { resolveOrchestrationMigrationStartVersion } from '../db/schema/orchestration-schema-version-skew'

describe('federated mailbox legacy-adoption probe', () => {
  let db: OrchestrationDb | undefined
  let directory: string | undefined

  afterEach(() => {
    db?.close()
    if (directory) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

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
