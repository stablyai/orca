import { initializeSessionSearchStorage } from './session-search-storage-bootstrap'
import type SyncDatabase from '../sqlite/sync-database'
import type { SessionSearchCatalogRow } from './session-search-catalog'
import { sessionSearchInventoryStorage } from './session-search-inventory-storage'

export class SessionSearchCatalogStorage {
  readonly inventory: ReturnType<typeof sessionSearchInventoryStorage>
  constructor(protected readonly db: SyncDatabase) {
    initializeSessionSearchStorage(db)
    db.exec(`CREATE TEMP TABLE search_catalog (
        scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
        parent TEXT NOT NULL, group_key TEXT NOT NULL, rank REAL NOT NULL,
        ready INTEGER NOT NULL, tie REAL NOT NULL DEFAULT 0, PRIMARY KEY(scope,key)
      ) WITHOUT ROWID;
      CREATE INDEX temp.search_catalog_key ON search_catalog(key,scope);
      CREATE INDEX temp.search_catalog_parent ON search_catalog(scope,parent,key);
      CREATE INDEX temp.search_catalog_parent_epoch ON search_catalog(scope,parent,group_key,key);
      CREATE INDEX temp.search_catalog_ready_queue ON search_catalog(scope,ready,rank,tie,key);
      CREATE INDEX temp.search_catalog_group ON search_catalog(scope,group_key,key);
      CREATE INDEX temp.search_catalog_queue ON search_catalog(scope,group_key,rank,tie,key);
      CREATE INDEX temp.search_catalog_revision ON search_catalog(scope,group_key,tie,key);
      CREATE INDEX temp.search_catalog_ready ON search_catalog(scope,ready,key);
      CREATE TEMP TABLE search_catalog_counts(scope TEXT PRIMARY KEY, n INTEGER NOT NULL, runnable INTEGER NOT NULL) WITHOUT ROWID;
      CREATE TEMP TRIGGER search_catalog_added AFTER INSERT ON search_catalog BEGIN
        INSERT INTO search_catalog_counts(scope,n,runnable) VALUES (NEW.scope,1,NEW.ready)
        ON CONFLICT(scope) DO UPDATE SET n=n+1,runnable=runnable+NEW.ready;
      END;
      CREATE TEMP TRIGGER search_catalog_removed AFTER DELETE ON search_catalog BEGIN
        UPDATE search_catalog_counts SET n=n-1,runnable=runnable-OLD.ready WHERE scope=OLD.scope;
      END;
      CREATE TEMP TRIGGER search_catalog_readied AFTER UPDATE OF ready ON search_catalog BEGIN
        UPDATE search_catalog_counts SET runnable=runnable+NEW.ready-OLD.ready WHERE scope=NEW.scope;
      END;`)
    this.inventory = sessionSearchInventoryStorage(db)
  }

  protected read(scope: string, key: string): SessionSearchCatalogRow[] {
    const owner = this.inventory.owner(scope)
    if (owner) {
      const row = this.inventory.get(owner, key)
      return row ? [row] : []
    }
    return this.db
      .prepare(
        'SELECT key,value,parent,group_key,rank,ready,tie FROM temp.search_catalog WHERE scope=? AND key=?'
      )
      .all(scope, key)
      .map((row) => this.decode(row))
  }

  protected decode(row: Record<string, unknown>): SessionSearchCatalogRow {
    return {
      key: String(row.key),
      value: String(row.value),
      parent: String(row.parent),
      group: String(row.group_key),
      rank: Number(row.rank),
      ready: Number(row.ready),
      tie: Number(row.tie)
    }
  }

  protected bytes(row: SessionSearchCatalogRow): number {
    return JSON.stringify(row).length * 2 + 64
  }
  frontierOrder(scope: string): number {
    return (
      Number(
        this.db
          .prepare(
            "SELECT rank FROM temp.search_catalog WHERE scope=? AND group_key='' ORDER BY rank DESC,key DESC LIMIT 1"
          )
          .get(scope)?.rank ?? 0
      ) + 1
    )
  }
}
