/** Match in-process admission in remote/WSL probes. backup arrived with required DatabaseSync options in Node 22.16; 22.13-22.15 need pinned-runtime fallback. */
export const NODE_SQLITE_READER_API_SOURCE =
  "(m)=>typeof m==='object'&&m!==null&&typeof m.DatabaseSync==='function'&&typeof m.backup==='function'"

/** Parity-tested in-process twin of NODE_SQLITE_READER_API_SOURCE. */
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
