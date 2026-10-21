import type Database from '../../../../sqlite/sync-database'
import { FEDERATED_STUB_HOME_RUN_ID_PREFIX } from '../contract-constants'

// Why: a rolled-back v1.4.198 host inserts attachments with home_run_id='' after user_version is
// already 40, so this idempotent repair runs on every open, not only inside the v40 migration.
export function backfillFederatedStubHomeRuns(db: Database.Database): void {
  db.exec(`
    INSERT OR IGNORE INTO runs (id, objective, home_database, consumer_generation, legacy)
    SELECT '${FEDERATED_STUB_HOME_RUN_ID_PREFIX}' || dispatch_id,
           'Coordinated from ' || home_peer_fingerprint, 'remote', 0, 0
    FROM remote_dispatch_attachments WHERE home_run_id = '';
    UPDATE remote_dispatch_attachments
    SET home_run_id = '${FEDERATED_STUB_HOME_RUN_ID_PREFIX}' || dispatch_id
    WHERE home_run_id = '';
  `)
}
