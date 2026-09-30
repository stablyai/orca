/**
 * Whether this Node can hold an index at all.
 *
 * The store is `node:sqlite`, reached through `process.getBuiltinModule`, which
 * neither exists on Node 18. That is not a hypothetical floor: orcad and the SSH
 * relay are both built for Node 18 and run on whatever the host has, and
 * build-orcad.mjs keeps that floor deliberately by excluding the only clusters
 * that import `node:sqlite` statically. A host without it registers no search
 * service at all rather than one that fails at every call.
 */
export function sessionSearchSqliteAvailable(): boolean {
  if (typeof process.getBuiltinModule !== 'function') {
    return false
  }
  try {
    const sqlite: unknown = process.getBuiltinModule('node:sqlite')
    return (
      typeof sqlite === 'object' &&
      sqlite !== null &&
      'DatabaseSync' in sqlite &&
      typeof sqlite.DatabaseSync === 'function'
    )
  } catch {
    return false
  }
}
