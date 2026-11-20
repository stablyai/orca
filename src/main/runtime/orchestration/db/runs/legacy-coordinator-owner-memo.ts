import type Database from '../../../../sqlite/sync-database'

const CHANGED_FUNCTION = 'orca_legacy_coordinator_inputs_changed'

/** The legacy coordinator lookup's answer, kept until a write to one of its inputs. Its mail and Task
 *  inputs are bounded by `adopted_at`, so after adoption only Dispatch assignees, principals, takeover
 *  rewrites and the adoption itself move it. TEMP triggers watch this connection's writes alone, and a
 *  rolled-back write still clears it; nothing is stored while a transaction is open. */
export type LegacyCoordinatorOwnerMemo = {
  read: (key: string, compute: () => string | null) => string | null
}

export function installLegacyCoordinatorOwnerMemo(db: Database.Database): LegacyCoordinatorOwnerMemo {
  let cached: { key: string; value: string | null } | undefined
  db.function(CHANGED_FUNCTION, () => {
    cached = undefined
    return null
  })
  const changed = `BEGIN SELECT ${CHANGED_FUNCTION}(); END;`
  db.exec(`
    CREATE TEMP TRIGGER IF NOT EXISTS orca_legacy_owner_dispatch_insert
    AFTER INSERT ON main.dispatch_contexts ${changed}
    CREATE TEMP TRIGGER IF NOT EXISTS orca_legacy_owner_dispatch_update
    AFTER UPDATE ON main.dispatch_contexts
    WHEN OLD.assignee_handle IS NOT NEW.assignee_handle OR OLD.run_id IS NOT NEW.run_id
      OR OLD.task_id IS NOT NEW.task_id OR OLD.contract_version IS NOT NEW.contract_version ${changed}
    CREATE TEMP TRIGGER IF NOT EXISTS orca_legacy_owner_dispatch_delete
    AFTER DELETE ON main.dispatch_contexts ${changed}
    CREATE TEMP TRIGGER IF NOT EXISTS orca_legacy_owner_principal_insert
    AFTER INSERT ON main.legacy_compatibility_principals ${changed}
    CREATE TEMP TRIGGER IF NOT EXISTS orca_legacy_owner_principal_update
    AFTER UPDATE ON main.legacy_compatibility_principals ${changed}
    CREATE TEMP TRIGGER IF NOT EXISTS orca_legacy_owner_principal_delete
    AFTER DELETE ON main.legacy_compatibility_principals ${changed}
    CREATE TEMP TRIGGER IF NOT EXISTS orca_legacy_owner_adoption_insert
    AFTER INSERT ON main.legacy_adoptions ${changed}
    CREATE TEMP TRIGGER IF NOT EXISTS orca_legacy_owner_adoption_update
    AFTER UPDATE ON main.legacy_adoptions ${changed}
    CREATE TEMP TRIGGER IF NOT EXISTS orca_legacy_owner_adoption_delete
    AFTER DELETE ON main.legacy_adoptions ${changed}
    CREATE TEMP TRIGGER IF NOT EXISTS orca_legacy_owner_coordinator_run_insert
    AFTER INSERT ON main.coordinator_runs ${changed}
    CREATE TEMP TRIGGER IF NOT EXISTS orca_legacy_owner_coordinator_run_update
    AFTER UPDATE ON main.coordinator_runs
    WHEN OLD.coordinator_handle IS NOT NEW.coordinator_handle
      OR OLD.scheduler_lost_at IS NOT NEW.scheduler_lost_at ${changed}
    CREATE TEMP TRIGGER IF NOT EXISTS orca_legacy_owner_coordinator_run_delete
    AFTER DELETE ON main.coordinator_runs ${changed}
    CREATE TEMP TRIGGER IF NOT EXISTS orca_legacy_owner_task_insert
    AFTER INSERT ON main.tasks WHEN NEW.created_by_terminal_handle IS NOT NULL ${changed}
    CREATE TEMP TRIGGER IF NOT EXISTS orca_legacy_owner_task_update
    AFTER UPDATE ON main.tasks
    WHEN OLD.created_by_terminal_handle IS NOT NEW.created_by_terminal_handle
      OR OLD.created_at IS NOT NEW.created_at OR OLD.run_id IS NOT NEW.run_id ${changed}
    CREATE TEMP TRIGGER IF NOT EXISTS orca_legacy_owner_task_delete
    AFTER DELETE ON main.tasks ${changed}
    CREATE TEMP TRIGGER IF NOT EXISTS orca_legacy_owner_mail_insert
    AFTER INSERT ON main.messages WHEN NEW.delivery_contract = 'legacy_direct' ${changed}
    CREATE TEMP TRIGGER IF NOT EXISTS orca_legacy_owner_mail_update
    AFTER UPDATE ON main.messages
    WHEN (OLD.delivery_contract = 'legacy_direct' OR NEW.delivery_contract = 'legacy_direct')
      AND (OLD.delivery_contract IS NOT NEW.delivery_contract OR OLD.from_handle IS NOT NEW.from_handle
        OR OLD.to_handle IS NOT NEW.to_handle OR OLD.run_id IS NOT NEW.run_id
        OR OLD.created_at IS NOT NEW.created_at) ${changed}
    CREATE TEMP TRIGGER IF NOT EXISTS orca_legacy_owner_mail_delete
    AFTER DELETE ON main.messages WHEN OLD.delivery_contract = 'legacy_direct' ${changed}
  `)
  return {
    read: (key, compute) => {
      if (cached?.key === key) {
        return cached.value
      }
      const value = compute()
      // Inside a transaction the answer may include writes a rollback undoes without a notice.
      if (!db.isTransaction) {
        cached = { key, value }
      }
      return value
    }
  }
}
