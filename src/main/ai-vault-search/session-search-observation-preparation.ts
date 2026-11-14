import { acknowledgeSessionSearchDirty } from './session-search-dirty-transition'
import { SessionSearchAuthorityPage } from './session-search-authority-page'
import { boundedSessionSearchPage } from './session-search-catalog-pages'
import { authorityValue } from './session-search-observation-authority'
import { recordSessionSearchRetry } from './session-search-retry-transition'
import type { SessionSearchCatalog } from './session-search-catalog'
import type {
  SessionSearchInventoryCommand,
  SessionSearchInventoryResult,
  SessionSearchObservationDebt
} from './session-search-observation-types'

export function prepareSessionSearchObservations(
  catalog: SessionSearchCatalog,
  command: Extract<SessionSearchInventoryCommand, { kind: 'observe-prepare' }>
): SessionSearchInventoryResult {
  const failures = `${command.scope}:file-refusals`
  const authority = new SessionSearchAuthorityPage(catalog, command.scope)
  const get = (scope: string, key: string) => authority.get(scope, key)
  const scopes = [
    `${command.scope}:files`,
    failures,
    `${failures}:eligible`,
    `${command.scope}:dirty`,
    `${command.scope}:dirty-expansion`,
    `${command.scope}:authority`,
    `${command.scope}:authority-root`,
    `${command.scope}:observing`,
    `${command.scope}:observation-epochs`
  ]
  const overheadBytes =
    JSON.stringify({
      prepared: [],
      scopeCounts: scopes.map((scope) => [scope, Number.MAX_VALUE, Number.MAX_VALUE])
    }).length * 2
  const prepared = boundedSessionSearchPage(
    authority.prefetched(command.inputs, 'prepare'),
    (input) => {
      const accepted = authority.file(input.path)
      if (input.requireMembership && !accepted) {
        throw new Error('Session search read has no physical inventory owner')
      }
      const refusal = get(failures, input.path)
      const debt = authorityValue<SessionSearchObservationDebt>(refusal)
      const dirty = get(`${command.scope}:dirty`, input.path)
      const stale =
        input.dirtyRevision !== undefined &&
        authorityValue<{ revision: number }>(dirty)?.revision !== input.dirtyRevision
      const previousToken = authority.observing(input.path)
      const previous: [number, number, number] | undefined = previousToken
        ? JSON.parse(previousToken)
        : undefined
      const reuse =
        input.dirtyRevision !== undefined &&
        previous &&
        previous[0] === (authority.file(input.path)?.revision ?? 0) &&
        previous[1] === (authorityValue<{ revision: number }>(dirty)?.revision ?? 0) &&
        authority.authority(input.path)?.self === previous[2]
      const revision = reuse ? previous[2] : catalog.nextRevision()
      const attempt =
        !stale && (!debt || (debt.failures < 3 && debt.attempted !== command.generation))
      const mergesDebt =
        !attempt &&
        debt &&
        (((input.force || input.readOwed) && !debt.force) || (input.metadataOwed && !debt.metadata))
      return {
        ...input,
        authority: revision,
        force: input.force || !!debt?.force,
        metadataOwed: input.metadataOwed || debt?.metadata,
        refusalRevision: mergesDebt ? catalog.nextRevision() : refusal?.tie,
        attempt,
        accepted,
        token: attempt
          ? JSON.stringify([
              accepted?.revision ?? 0,
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
          authority.forget(`${failures}:eligible`, input.path)
        }
        if (!input.attempt && input.dirtyRevision !== undefined) {
          acknowledgeSessionSearchDirty(catalog, command.scope, input.path, input.dirtyRevision)
          authority.forget(`${command.scope}:dirty`, input.path)
          authority.settle(input.path)
        }
        if (input.attempt) {
          authority.record(input.path, input.authority, 0)
          authority.putObserving(input.path, input.token)
          authority.epoch(input.authority, input.path)
        }
      }
    }
  )
  authority.flush()
  return { prepared }
}
