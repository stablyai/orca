# Legacy profile JSON

SQLite is the only ordinary writable profile backend. This folder retains import,
explicit export and recovery for `orca-data.json`; it does not provide a second
live store or refresh JSON on shutdown, update or profile maintenance.

| Code                                                                   | Purpose                                                                                                                                                                            |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `profile-state-legacy-import.ts`                                       | Normalize an old profile through a frozen Store, trying the old backup ring if the primary JSON is unreadable. Publication and secret-retention commit stay with SQLite bootstrap. |
| `profile-state-legacy-backup-path.ts`                                  | Recognize the five old `.bak` files for import and missing-authority checks. No live JSON backup rotation remains.                                                                 |
| `profile-state-authority-exports.ts`                                   | Export a consistent SQLite snapshot on explicit request.                                                                                                                           |
| `profile-state-json-acceptance.ts`                                     | Read accepted JSON hashes, including both sides of an interrupted compatibility export from an earlier build.                                                                      |
| `profile-state-versioned-export.ts` and `profile-state-export-path.ts` | Publish immutable recovery exports and retain the latest five. Migration retains its initial recovery export.                                                                      |
| `profile-state-recovery.ts`                                            | Restore explicitly selected JSON after archiving the database and recovery evidence. The next capable startup imports it back into SQLite.                                         |

Old profiles may upgrade directly; no intermediate release is required. A copy
source can still be read as JSON, but every profile changed by a transfer or an
offline settings command must first establish SQLite authority. The original
JSON remains unchanged after import and may be much older than SQLite.

Before using a JSON-only build, stop Orca and run the current bundled CLI's
`orca profile state rollback --latest-json`. This exports the latest committed
SQLite state and selects that JSON after archiving the current database and
recovery artifacts. Do this on the machine that owns the profile, including SSH
hosts. An interrupted command preserves recovery evidence; inspect
`orca profile state exports` and select the retained `--revision` to retry after
the database has been removed. Older SQLite-capable builds still require a
compatible database schema.

If an older build has already edited JSON separately, startup refuses to choose
silently between it and SQLite. `orca profile state rollback --current-json`
selects those edits and archives both copies; it does not merge divergent
histories. `--latest-json` deliberately selects SQLite instead.

The durable `profile-state.db.authority` marker records that SQLite was
established, even before the first backup. It prevents missing SQLite from
silently reviving stale JSON or creating an empty profile. Only explicit JSON
recovery removes it, after publishing the selected state and archiving evidence.
Keep complete profile directories when moving or restoring them; deleting every
artifact proving SQLite existed defeats any missing-database check.

Keep direct import, old-backup reading, explicit exports and recovery while old
profiles or backups remain supported. They are independent of automatic JSON
snapshots. SQLite admission, transactions, backups and recovery dispatch stay in
the parent folder. Profile-index metadata, move journals, caches, wire messages,
external-tool settings and JSON documents inside SQLite are unrelated formats.
