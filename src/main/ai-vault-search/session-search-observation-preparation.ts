import { acknowledgeSessionSearchDirty } from './session-search-dirty-transition'
import { dirname } from 'node:path'
import { SessionSearchAuthorityPage } from './session-search-authority-page'
import { boundedSessionSearchPage } from './session-search-catalog-pages'
import { authorityValue, putAuthorityValue } from './session-search-observation-authority'
import { recordSessionSearchRetry } from './session-search-retry-transition'
import type { SessionSearchCatalog } from './session-search-catalog'
import type {
  SessionSearchInventoryCommand,
  SessionSearchInventoryResult,
  SessionSearchObservationDebt,
  SessionSearchObservedFacts
} from './session-search-observation-types'

export function prepareSessionSearchObservations(
  catalog: SessionSearchCatalog,
  command: Extract<SessionSearchInventoryCommand, { kind: 'observe-prepare' }>
): SessionSearchInventoryResult {
  const files = `${command.scope}:files`
  const failures = `${command.scope}:file-refusals`
  const observing = `${command.scope}:observing`
  const authority = new SessionSearchAuthorityPage(catalog, command.scope)
  const get = (scope: string, key: string) => authority.get(scope, key)
  const put = (scope: string, key: string, value: unknown) => {
    const row = {
      key,
      value: JSON.stringify(value),
      parent: dirname(key),
      group: '',
      rank: 0,
      ready: 0
    }
    catalog.execute({ kind: 'put', scope, rows: [row] })
    authority.changed(scope, key, row)
  }
  const scopes = [
    files,
    failures,
    `${failures}:eligible`,
    `${command.scope}:dirty`,
    `${command.scope}:dirty-expansion`,
    `${command.scope}:authority`,
    `${command.scope}:authority-root`,
    observing,
    `${command.scope}:observation-epochs`
  ]
  const overheadBytes =
    JSON.stringify({
      prepared: [],
      scopeCounts: scopes.map((scope) => [scope, Number.MAX_VALUE, Number.MAX_VALUE])
    }).length * 2
  const prepared = boundedSessionSearchPage(
    command.inputs,
    (input) => {
      const refusal = get(failures, input.path)
      const debt = authorityValue<SessionSearchObservationDebt>(refusal)
      const dirty = get(`${command.scope}:dirty`, input.path)
      const stale =
        input.dirtyRevision !== undefined &&
        authorityValue<{ revision: number }>(dirty)?.revision !== input.dirtyRevision
      const previousToken = authorityValue<string>(get(observing, input.path))
      const previous: [number, number, number] | undefined = previousToken
        ? JSON.parse(previousToken)
        : undefined
      const reuse =
        input.dirtyRevision !== undefined &&
        previous &&
        previous[0] ===
          (authorityValue<SessionSearchObservedFacts>(get(files, input.path))?.revision ?? 0) &&
        previous[1] === (authorityValue<{ revision: number }>(dirty)?.revision ?? 0) &&
        authority.authority(input.path)?.self === previous[2]
      const revision = reuse ? previous[2] : catalog.nextRevision()
      const attempt =
        !stale && (!debt || (debt.failures < 3 && debt.attempted !== command.generation))
      const mergesDebt =
        !attempt &&
        debt &&
        (((input.force || input.readOwed) && !debt.force) || (input.metadataOwed && !debt.metadata))
      const accepted = get(files, input.path)
      return {
        ...input,
        authority: revision,
        force: input.force || !!debt?.force,
        metadataOwed: input.metadataOwed || debt?.metadata,
        refusalRevision: mergesDebt ? catalog.nextRevision() : refusal?.tie,
        attempt,
        accepted: authorityValue<SessionSearchObservedFacts>(accepted),
        token: attempt
          ? JSON.stringify([
              authorityValue<SessionSearchObservedFacts>(accepted)?.revision ?? 0,
              authorityValue<{ revision: number }>(get(`${command.scope}:dirty`, input.path))
                ?.revision ?? 0,
              revision
            ])
          : ''
      }
    },
    {
      overheadBytes,
      accept: (input) => {
        const debt = authorityValue<SessionSearchObservationDebt>(get(failures, input.path))
        if (
          !input.attempt &&
          debt &&
          (((input.force || input.readOwed) && !debt.force) ||
            (input.metadataOwed && !debt.metadata))
        ) {
          recordSessionSearchRetry(
            catalog,
            failures,
            input.path,
            {
              ...debt,
              force: debt.force || input.force || !!input.readOwed,
              metadata: debt.metadata || input.metadataOwed
            },
            input.refusalRevision
          )
          authority.forget(failures, input.path)
        }
        if (!input.attempt && input.dirtyRevision !== undefined) {
          acknowledgeSessionSearchDirty(catalog, command.scope, input.path, input.dirtyRevision)
          authority.forget(`${command.scope}:dirty`, input.path)
          authority.settle(input.path)
        }
        if (input.attempt) {
          authority.record(input.path, input.authority, 0)
          put(observing, input.path, input.token)
          putAuthorityValue(
            catalog,
            `${command.scope}:observation-epochs`,
            String(input.authority),
            input.path,
            input.authority
          )
        }
      }
    }
  )
  authority.flush()
  return { prepared }
}
