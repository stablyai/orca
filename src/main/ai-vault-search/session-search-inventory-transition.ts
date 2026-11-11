import { acknowledgeSessionSearchDirty } from './session-search-dirty-transition'
import { SessionSearchAuthorityPage } from './session-search-authority-page'
import { SESSION_INPUT_FAILURES_BEFORE_HELD_OUT } from '../ai-vault/session-observation-retries'
import { recordSessionSearchRetry } from './session-search-retry-transition'
import { cleanupSessionSearchAuthority } from './session-search-observation-authority'
import { prepareSessionSearchObservations } from './session-search-observation-preparation'
import type { SessionSearchCatalog, SessionSearchCatalogRow } from './session-search-catalog'
import { sidecarUnchanged } from '../ai-vault/parse-cache/session-sidecar-stat'
import { dirname } from 'node:path'

import type {
  SessionSearchInventoryCommand,
  SessionSearchInventoryResult,
  SessionSearchObservationDebt,
  SessionSearchObservedFacts
} from './session-search-observation-types'
export type {
  SessionSearchObservationDebt,
  SessionSearchObservedFacts,
  SessionSearchObservationInput,
  SessionSearchPreparedObservation,
  SessionSearchObservationOutcome,
  SessionSearchInventoryCommand,
  SessionSearchInventoryResult
} from './session-search-observation-types'

function decode<T>(row: SessionSearchCatalogRow | undefined): T | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: scratch rows are written only by the matching typed inventory scope.
  return row ? (JSON.parse(row.value) as T) : undefined
}

/** Accepted observations and retry transitions share the writer's keyed transaction. */
export function transitionSessionSearchInventory(
  catalog: SessionSearchCatalog,
  command: SessionSearchInventoryCommand
): SessionSearchInventoryResult {
  if (command.kind === 'observe-prepare') {
    return prepareSessionSearchObservations(catalog, command)
  }
  const files = `${command.scope}:files`
  const failures = `${command.scope}:file-refusals`
  const authority = new SessionSearchAuthorityPage(catalog, command.scope)
  const get = (scope: string, key: string) => authority.get(scope, key)
  const put = (scope: string, key: string, value: unknown, group = '', ready = 0) => {
    const row = { key, value: JSON.stringify(value), parent: dirname(key), group, rank: 0, ready }
    catalog.execute({ kind: 'put', scope, rows: [row] })
    authority.changed(scope, key, row)
  }
  const remove = (scope: string, key: string) => {
    catalog.execute({ kind: 'delete', scope, key })
    authority.changed(scope, key)
  }
  const observing = `${command.scope}:observing`
  const delivery = `${command.scope}:delivery`
  if (command.kind === 'observe-ack') {
    for (const receipt of command.receipts) {
      const row = get(delivery, receipt.path)
      if (row && JSON.parse(row.value).revision === receipt.revision) {
        remove(delivery, receipt.path)
        authority.settle(receipt.path)
      }
    }
    authority.flush()
    cleanupSessionSearchAuthority(catalog, command.scope)
    return {}
  }
  const token = (path: string) => [
    decode<SessionSearchObservedFacts>(get(files, path))?.revision ?? 0,
    decode<{ revision: number }>(get(`${command.scope}:dirty`, path))?.revision ?? 0,
    authority.authority(path)?.self ?? 0
  ]
  let filesDelta = 0,
    failuresDelta = 0,
    runnableDelta = 0
  const refusals: { path: string; revision: number }[] = []
  const missingParents: string[] = []
  const observations: NonNullable<SessionSearchInventoryResult['observations']> = []
  const debtChange = (
    path: string,
    previous: SessionSearchObservationDebt | undefined,
    next: SessionSearchObservationDebt | undefined
  ) => {
    failuresDelta += Number(!!next) - Number(!!previous)
    runnableDelta +=
      Number(!!next && next.failures < 3) - Number(!!previous && previous.failures < 3)
    recordSessionSearchRetry(catalog, failures, path, next)
    authority.forget(failures, path)
    if (next) {
      refusals.push({ path, revision: get(failures, path)!.tie! })
    }
  }
  if (command.kind === 'forget-files') {
    const removedFiles: string[] = []
    const cutoff = command.cutoff ?? catalog.nextRevision()
    for (const path of command.paths) {
      if (authority.newer(path, cutoff)) {
        continue
      }
      removedFiles.push(path)
      authority.record(path, cutoff, 0)
      const known = !!get(files, path)
      filesDelta -= Number(known)
      if (known && command.notify !== false) {
        put(delivery, path, {
          removed: true,
          force: false,
          revision: catalog.nextRevision(),
          authority: cutoff
        })
      }
      remove(files, path)
      remove(observing, path)
      debtChange(path, decode<SessionSearchObservationDebt>(get(failures, path)), undefined)
      remove(`${command.scope}:dirty`, path)
      authority.settle(path)
    }
    authority.flush()
    return { filesDelta, failuresDelta, runnableDelta, removedFiles }
  }
  for (const outcome of command.outcomes) {
    try {
      remove(`${command.scope}:observation-epochs`, String(outcome.authority))
      const current = get(files, outcome.path)
      const expected = JSON.parse(outcome.token)
      const ownsObservation = decode<string>(get(observing, outcome.path)) === outcome.token
      if (
        !ownsObservation ||
        JSON.stringify(token(outcome.path)) !== JSON.stringify(expected) ||
        authority.newer(outcome.path, outcome.authority)
      ) {
        if (ownsObservation) {
          remove(observing, outcome.path)
          const debt = decode<SessionSearchObservationDebt>(get(failures, outcome.path))
          if (debt && debt.failures < SESSION_INPUT_FAILURES_BEFORE_HELD_OUT) {
            recordSessionSearchRetry(catalog, failures, outcome.path, debt)
          }
        }
        continue
      }
      remove(observing, outcome.path)
      if (outcome.dirtyRevision !== undefined) {
        acknowledgeSessionSearchDirty(catalog, command.scope, outcome.path, outcome.dirtyRevision)
        authority.forget(`${command.scope}:dirty`, outcome.path)
      }
      const accepted = decode<SessionSearchObservedFacts>(current)
      const previous = decode<SessionSearchObservationDebt>(get(failures, outcome.path))
      if (previous?.attempted === command.generation) {
        continue
      }
      const force = outcome.force || !!previous?.force
      if (!outcome.observed) {
        if (outcome.missing && !accepted) {
          debtChange(outcome.path, previous, undefined)
        } else {
          debtChange(outcome.path, previous, {
            failures: (previous?.failures ?? 0) + 1,
            attempted: command.generation,
            force: force || !!outcome.readOwed,
            metadata: outcome.metadataOwed || previous?.metadata,
            issue: outcome.issue ?? previous?.issue
          })
          if (outcome.missing) {
            missingParents.push(dirname(outcome.path))
          }
        }
        continue
      }
      const facts = { ...outcome.observed.file }
      const unknown = !outcome.metadataOnly && facts.sidecar === 'unknown'
      if (unknown) {
        debtChange(outcome.path, previous, {
          failures: (previous?.failures ?? 0) + 1,
          attempted: command.generation,
          force: force || !!outcome.readOwed,
          metadata: outcome.metadataOwed || previous?.metadata,
          issue: previous?.issue
        })
        facts.sidecar = accepted?.file.sidecar ?? 'unknown'
      } else {
        debtChange(outcome.path, previous, undefined)
      }
      const dependencyChanged =
        !outcome.metadataOnly &&
        !!accepted &&
        facts.sidecar !== 'unknown' &&
        !sidecarUnchanged(accepted.file.sidecar ?? 'none', facts.sidecar ?? 'none')
      put(
        files,
        outcome.path,
        {
          revision: outcome.authority,
          file: facts,
          dependency: outcome.metadataOnly ? undefined : outcome.observed.dependency
        },
        outcome.metadataOnly ? '' : outcome.observed.dependency
      )
      authority.ensureDirectories(outcome.path)
      filesDelta += Number(!accepted)
      const old = accepted?.file
      const same =
        !!old &&
        old.mtimeMs === facts.mtimeMs &&
        old.sizeBytes === facts.sizeBytes &&
        old.dev === facts.dev &&
        old.ino === facts.ino
      const metadata = outcome.metadataOwed || previous?.metadata
      if (force || !same || dependencyChanged || metadata) {
        const owed = decode<{ force?: boolean; metadata?: boolean }>(get(delivery, outcome.path))
        put(delivery, outcome.path, {
          file: facts,
          metadata: metadata || owed?.metadata,
          force: !!owed?.force || dependencyChanged || (force && same),
          revision: catalog.nextRevision()
        })
      }
      observations.push({
        path: outcome.path,
        file: { ...facts, modifiedAt: new Date(facts.mtimeMs).toISOString() },
        changed: force || !same || dependencyChanged || !!metadata,
        metadata,
        force: dependencyChanged || (force && same),
        readable: !unknown
      })
    } finally {
      authority.settle(outcome.path)
    }
  }
  authority.flush()
  cleanupSessionSearchAuthority(catalog, command.scope)
  return { observations, refusals, filesDelta, failuresDelta, runnableDelta, missingParents }
}
