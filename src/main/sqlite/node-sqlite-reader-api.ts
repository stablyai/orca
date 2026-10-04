/**
 * Source of the node:sqlite admission check, embedded in remote/WSL probe scripts so a
 * host's Node passes exactly when `isSqliteAvailable()` would admit it there.
 * Why `backup`: it landed with the DatabaseSync options SyncDatabase relies on (Node 22.16),
 * so Node 22.13–22.15 must take the pinned-runtime fallback.
 */
export const NODE_SQLITE_READER_API_SOURCE =
  "(m)=>typeof m==='object'&&m!==null&&typeof m.DatabaseSync==='function'&&typeof m.backup==='function'"

/** In-process twin of {@link NODE_SQLITE_READER_API_SOURCE}; a parity test keeps them equal. */
export function hasNodeSqliteReaderApi(sqlite: unknown): boolean {
  return (
    typeof sqlite === 'object' &&
    sqlite !== null &&
    'DatabaseSync' in sqlite &&
    typeof sqlite.DatabaseSync === 'function' &&
    'backup' in sqlite &&
    typeof sqlite.backup === 'function'
  )
}
