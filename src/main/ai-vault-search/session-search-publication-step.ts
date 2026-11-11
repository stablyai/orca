import type { SessionSearchStore } from './storage/session-search-store'
import { readSessionSearchSnapshotRows } from './session-search-snapshot-rows'
import type { SessionSearchSnapshotRow } from './worker/session-search-worker-protocol'
import { fileIdentity } from './storage/session-search-file-cursor'

/** A cleanup quantum captures existing debt and charges actual withdrawal failures in one owner. */
export async function stepSessionSearchPublication(
  store: SessionSearchStore
): Promise<{ processed: number; withdrawn: SessionSearchSnapshotRow[] }> {
  const catalog = store.catalogCandidates
  let publication = catalog.execute({ kind: 'publication-next' }).publication
  const withdrawn: SessionSearchSnapshotRow[] = []
  if (!publication) {
    return { processed: 0, withdrawn }
  }
  const page = catalog.execute({
    kind: 'group',
    group: publication.group,
    after: publication.cursor
  })
  let cursor = publication.cursor
  let blocked = false
  let failed = false
  for (const row of page.rows) {
    const path = row.candidate.file.path
    if (publication.phase === 'coverage' && row.selected) {
      const work = (await store.work({ kind: 'get', path })).work
      const observation = store.connection
        .prepare(`SELECT 1 FROM temp.search_catalog
        WHERE key=? AND scope LIKE '%:file-refusals' AND json_extract(value,'$.force')=1 LIMIT 1`)
        .get(path)
      if (work?.force || work?.metadata || observation) {
        catalog.execute({ kind: 'require', path })
        publication =
          catalog.execute({ kind: 'publication-current', group: publication.group }).publication ??
          publication
        blocked = true
        break
      }
      const saved = store.fileRow(path)
      const identity = fileIdentity(row.candidate.file)
      if (
        row.required ||
        saved?.state !== 'current' ||
        saved.mtimeMs !== row.candidate.file.mtimeMs ||
        saved.byteOffset === null ||
        saved.byteOffset === undefined ||
        saved.byteOffset < 0 ||
        (row.candidate.file.sizeBytes !== undefined &&
          (saved.sizeBytes !== row.candidate.file.sizeBytes ||
            saved.byteOffset !== row.candidate.file.sizeBytes)) ||
        (identity &&
          (!saved.identity ||
            identity.dev !== saved.identity.dev ||
            identity.ino !== saved.identity.ino))
      ) {
        blocked = true
        break
      }
    } else if (publication.phase === 'withdraw' && !row.selected) {
      try {
        const previous = readSessionSearchSnapshotRows(store, path)[0]
        if (
          !catalog.execute({
            kind: 'withdraw',
            group: publication.group,
            revision: publication.revision,
            frontier: publication.frontier,
            path
          }).accepted
        ) {
          failed = true
          break
        }
        if (previous && !store.fileRow(path)) {
          withdrawn.push(previous)
        }
      } catch {
        failed = true
        break
      }
    }
    cursor = row.key
  }
  const complete = page.rows.length === 0
  const phase = complete && publication.phase === 'coverage' ? 'withdraw' : publication.phase
  catalog.execute({
    kind: 'publication-update',
    group: publication.group,
    revision: publication.revision,
    frontier: publication.frontier,
    cursor: phase !== publication.phase ? '' : cursor,
    phase,
    dirty: !blocked && !(complete && publication.phase === 'withdraw'),
    failed
  })
  return { processed: Math.max(1, page.rows.length), withdrawn }
}
