export const JOURNAL_DOMAIN_MAINTENANCE_SCHEMA = `
CREATE TABLE journal_maintenance (
  id INTEGER PRIMARY KEY CHECK(id=1),
  compacted_at INTEGER NOT NULL
);
`
