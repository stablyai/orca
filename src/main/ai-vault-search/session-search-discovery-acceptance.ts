import type { SessionSearchStore } from './storage/session-search-store'
import type {
  SessionSearchCandidateCommand,
  SessionSearchCandidateResult
} from './session-search-catalog-candidate-types'
import { acceptSessionSearchCandidatePage } from './session-search-candidate-admission-page'
import { authorityValue } from './session-search-authority-page'

/** A receipt is acknowledged only in the transaction that accepts its successor. */
export function acceptSessionSearchDiscoveryPage(
  store: SessionSearchStore,
  command: Extract<SessionSearchCandidateCommand, { kind: 'batch' }>
): SessionSearchCandidateResult {
  const queue = store.catalogWork
  return store.catalogStorage.transaction('search_discovery_accept', () => {
    const accepted = command.rows.filter((row) => {
      if (!row.input) {
        return true
      }
      const current = store.catalogStorage.valueRow(
        `${row.input.scope}:delivery`,
        row.candidate.file.path
      )
      return authorityValue<{ revision: number }>(current)?.revision === row.input.revision
    })
    store.catalogCandidates.execute({ kind: 'batch', rows: accepted })
    const dependencyScopes = new Set<string>()
    for (const row of accepted) {
      for (const owner of row.input?.dependencyOwners ?? []) {
        const path = row.candidate.file.path
        const previous = store.catalogStorage.valueRow(owner.scope, path)
        if (authorityValue<string>(previous) !== owner.key) {
          store.catalogStorage.putValue(owner.scope, {
            key: path,
            data: owner.key,
            parent: owner.key,
            group: '',
            rank: 0,
            ready: 0
          })
        }
        dependencyScopes.add(owner.scope)
      }
    }
    const changed = store.catalogCandidates.execute({ kind: 'changes' }).rows
    const scopeCounts: [string, number, number][] = []
    const record = (result: { scopeCounts?: [string, number, number][] }) => {
      scopeCounts.push(...(result.scopeCounts ?? []))
    }
    record(
      store.catalogStorage.response({
        kind: 'delete-page',
        scope: 'parked-retirement',
        keys: changed.filter((row) => row.selected).map((row) => row.candidate.file.path)
      })
    )
    const admitted = acceptSessionSearchCandidatePage(
      store,
      queue,
      {
        kind: 'admit',
        rows: changed.map(({ key, revision }) => ({ key, revision })),
        recent: command.admission!.recent,
        recovering: command.admission!.recovering
      },
      changed
    )
    record(admitted)
    const scopes = new Set(accepted.flatMap((row) => (row.input ? [row.input.scope] : [])))
    for (const scope of scopes) {
      record(
        store.catalogStorage.response({
          kind: 'observe-ack',
          scope,
          receipts: accepted
            .filter((row) => row.input?.scope === scope)
            .map((row) => ({ path: row.candidate.file.path, revision: row.input!.revision }))
        })
      )
    }
    const metadata = accepted.flatMap((row) =>
      row.input?.metadataValue === undefined
        ? []
        : [
            {
              key: row.candidate.file.path,
              value: row.input.metadataValue
            }
          ]
    )
    if (metadata.length) {
      record(
        store.catalogStorage.response({
          kind: 'ack-values',
          scope: 'discovery-metadata',
          rows: metadata
        })
      )
    }
    for (const scope of dependencyScopes) {
      record(store.catalogStorage.response({ kind: 'count', scope }))
    }
    return { ...admitted, scopeCounts }
  })
}
