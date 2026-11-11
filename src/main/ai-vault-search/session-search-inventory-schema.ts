import type SyncDatabase from '../sqlite/sync-database'

export function initializeSessionSearchInventory(db: SyncDatabase): void {
  db.exec(`CREATE TEMP TABLE search_inventory_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL UNIQUE, root TEXT NOT NULL
  );
  CREATE TEMP TABLE search_inventory_entries (
    id INTEGER PRIMARY KEY, source INTEGER NOT NULL, path TEXT NOT NULL,
    parent TEXT NOT NULL, file_revision INTEGER, directory INTEGER NOT NULL DEFAULT 0,
    mtime REAL, size REAL, dev REAL, ino REAL, nlink REAL, alias_mtime REAL,
    sidecar TEXT, dependency TEXT,
    UNIQUE(source,path)
  );
  CREATE INDEX temp.search_inventory_parent ON search_inventory_entries(source,parent,path);
  CREATE INDEX temp.search_inventory_dependency ON search_inventory_entries(source,dependency,path)
    WHERE file_revision IS NOT NULL;
  CREATE TEMP TABLE search_inventory_staging (
    id INTEGER PRIMARY KEY, source INTEGER NOT NULL, path TEXT NOT NULL,
    parent TEXT NOT NULL, epoch TEXT NOT NULL, file INTEGER, directory INTEGER,
    UNIQUE(source,path)
  );
  CREATE INDEX temp.search_inventory_staged ON search_inventory_staging(source,parent,epoch,path);
  CREATE TEMP TABLE search_inventory_activity (
    id INTEGER PRIMARY KEY, source INTEGER NOT NULL, path TEXT NOT NULL, parent TEXT NOT NULL,
    authority_self INTEGER, authority_tree INTEGER, reclaimable INTEGER,
    observation_file INTEGER, observation_dirty INTEGER, observation_authority INTEGER,
    observation_epoch INTEGER,
    delivery_revision INTEGER, delivery_removed INTEGER, delivery_force INTEGER,
    delivery_metadata INTEGER, delivery_authority INTEGER,
    delivery_mtime REAL, delivery_size REAL, delivery_dev REAL, delivery_ino REAL,
    delivery_nlink REAL, delivery_alias_mtime REAL, delivery_sidecar TEXT,
    UNIQUE(source,path)
  );
  CREATE INDEX temp.search_inventory_reclaim ON search_inventory_activity(source,reclaimable,authority_tree,path)
    WHERE authority_self IS NOT NULL;
  CREATE INDEX temp.search_inventory_observation_floor ON search_inventory_activity(source,observation_epoch,path)
    WHERE observation_epoch IS NOT NULL;
  CREATE INDEX temp.search_inventory_delivery ON search_inventory_activity(source,path)
    WHERE delivery_revision IS NOT NULL;
  CREATE TEMP TABLE search_inventory_epochs (
    id INTEGER PRIMARY KEY, source INTEGER NOT NULL, kind TEXT NOT NULL, path TEXT NOT NULL,
    revision INTEGER NOT NULL, cutoff INTEGER NOT NULL, sealed INTEGER NOT NULL,
    UNIQUE(source,kind,path)
  );
  CREATE INDEX temp.search_inventory_epoch_floor ON search_inventory_epochs(source,kind,cutoff,path);`)
  for (const [name, table, suffix, present, ready] of [
    ['files', 'entries', "'files'", 'file_revision IS NOT NULL', '0'],
    ['directories', 'entries', "'directories'", 'directory=1', '0'],
    ['staging', 'staging', "'directory-input'", '1', '0'],
    [
      'authority',
      'activity',
      "'authority'",
      'authority_self IS NOT NULL',
      'COALESCE(reclaimable,0)'
    ],
    ['observing', 'activity', "'observing'", 'observation_authority IS NOT NULL', '0'],
    ['observations', 'activity', "'observation-epochs'", 'observation_epoch IS NOT NULL', '0'],
    ['delivery', 'activity', "'delivery'", 'delivery_revision IS NOT NULL', '0'],
    ['epochs', 'epochs', 'kind', '1', '0']
  ]) {
    const qualify = (text: string, prefix: string) =>
      text.replace(
        /\b(file_revision|directory|authority_self|reclaimable|observation_authority|observation_epoch|delivery_revision|kind)\b/g,
        `${prefix}.$1`
      )
    const current = qualify(present, 'NEW'),
      previous = qualify(present, 'OLD')
    const nowReady = qualify(ready, 'NEW'),
      oldReady = qualify(ready, 'OLD')
    const adjust = (prefix: string, delta: string, runnable: string) => `
      INSERT INTO search_catalog_counts(scope,n,runnable)
      SELECT scope||':'||${suffix === 'kind' ? `${prefix}.kind` : suffix},${delta},${runnable}
      FROM search_inventory_sources WHERE id=${prefix}.source
      ON CONFLICT(scope) DO UPDATE SET n=n+excluded.n,runnable=runnable+excluded.runnable;`
    db.exec(`CREATE TEMP TRIGGER search_inventory_${name}_added AFTER INSERT ON search_inventory_${table}
      WHEN ${current} BEGIN ${adjust('NEW', '1', nowReady)} END;
      CREATE TEMP TRIGGER search_inventory_${name}_removed AFTER DELETE ON search_inventory_${table}
      WHEN ${previous} BEGIN ${adjust('OLD', '-1', `-(${oldReady})`)} END;
      CREATE TEMP TRIGGER search_inventory_${name}_changed AFTER UPDATE ON search_inventory_${table}
      WHEN (${current})<>(${previous}) OR (${current})*(${nowReady})<>(${previous})*(${oldReady})
      BEGIN ${adjust('NEW', `(${current})-(${previous})`, `(${current})*(${nowReady})-(${previous})*(${oldReady})`)} END;`)
  }
}
