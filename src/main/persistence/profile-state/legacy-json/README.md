# Legacy profile JSON

SQLite is the only ordinary writable profile backend. This folder retains the
`orca-data.json` compatibility boundary; it does not provide a second live store.

| Code                                                                   | Purpose                                                                                                                                                                                |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `profile-state-legacy-import.ts`                                       | Normalize an old profile through a frozen Store, trying the old backup ring if the primary JSON is unreadable. Publication and secret-retention commit stay with the SQLite bootstrap. |
| `profile-state-legacy-backup-path.ts`                                  | Recognize the five old `.bak` files for import and missing-authority checks. No live JSON backup rotation remains.                                                                     |
| `profile-state-authority-exports.ts`                                   | Export a consistent SQLite snapshot for explicit export, clean shutdown, or profile maintenance.                                                                                       |
| `profile-state-json-acceptance.ts`                                     | Record which exact JSON bytes SQLite accepts, including both sides of an interrupted compatibility export.                                                                             |
| `profile-state-versioned-export.ts` and `profile-state-export-path.ts` | Publish immutable recovery exports and retain the latest five.                                                                                                                         |
| `profile-state-recovery.ts`                                            | Restore explicitly selected JSON after archiving the database and recovery evidence. The next capable startup imports it back into SQLite.                                             |

Old profiles may upgrade directly; no intermediate release is required. A copy
source can still be read as JSON, but every profile changed by a transfer or an
offline settings command must first establish SQLite authority.

Clean shutdown and maintenance refresh compatibility JSON for older builds. A
crash or failed export can leave an older snapshot. If an older build edits that
file, startup refuses to choose silently between it and SQLite. The explicit
`orca profile state rollback --current-json` command selects those edits and
archives both copies; it does not merge divergent histories.

Keep import and recovery while old profiles or backups remain supported. Removing
automatic compatibility exports is a separate compatibility decision requiring a
policy for older builds and recovery when a database is missing. Deleting the
ordinary JSON writer does not justify deleting these safeguards.

SQLite admission, transactions, row serialization, backups, and recovery command
dispatch stay in the parent folder. In particular, JSON payloads in SQLite are
its document representation, not a legacy file backend. Profile-index metadata,
move journals, caches, wire messages, and external-tool settings are also outside
this boundary.
