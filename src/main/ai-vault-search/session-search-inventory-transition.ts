import { boundedSessionSearchPage } from './session-search-catalog-pages'
import type { AiVaultScanIssue } from '../../shared/ai-vault/contracts/ai-vault-types'
import type { FileWithMtime } from '../ai-vault/session-scanner-types'
import type { SessionSearchCatalog, SessionSearchCatalogRow } from './session-search-catalog'
import { sidecarUnchanged } from '../ai-vault/parse-cache/session-sidecar-stat'
import { dirname } from 'node:path'

export type SessionSearchObservedFacts = {
  file: Omit<FileWithMtime, 'modifiedAt'>
  dependency?: string
}
export type SessionSearchObservationDebt = {
  failures: number
  attempted: number
  force: boolean
  issue?: AiVaultScanIssue
}
export type SessionSearchObservationInput = { path: string; force: boolean; readOwed?: boolean }
export type SessionSearchPreparedObservation = SessionSearchObservationInput & {
  accepted?: SessionSearchObservedFacts
  token: string
  attempt: boolean
}
export type SessionSearchObservationOutcome = SessionSearchPreparedObservation & {
  observed?: SessionSearchObservedFacts
  metadataOnly?: boolean
  missing?: boolean
  issue?: AiVaultScanIssue
}
export type SessionSearchInventoryCommand =
  | {
      kind: 'observe-prepare'
      scope: string
      generation: number
      inputs: SessionSearchObservationInput[]
    }
  | {
      kind: 'observe-apply'
      scope: string
      generation: number
      outcomes: SessionSearchObservationOutcome[]
    }
  | { kind: 'forget-files'; scope: string; paths: string[] }
export type SessionSearchInventoryResult = {
  prepared?: SessionSearchPreparedObservation[]
  observations?: {
    path: string
    file?: FileWithMtime
    changed: boolean
    force: boolean
    readable: boolean
  }[]
  filesDelta?: number
  failuresDelta?: number
  runnableDelta?: number
  missingParents?: string[]
}

function decode<T>(row: SessionSearchCatalogRow | undefined): T | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: scratch rows are written only by the matching typed inventory scope.
  return row ? (JSON.parse(row.value) as T) : undefined
}

/** Accepted observations and retry transitions share the writer's keyed transaction. */
export function transitionSessionSearchInventory(
  catalog: SessionSearchCatalog,
  command: SessionSearchInventoryCommand
): SessionSearchInventoryResult {
  const files = `${command.scope}:files`
  const failures = `${command.scope}:file-refusals`
  const get = (scope: string, key: string) => catalog.execute({ kind: 'get', scope, key }).rows?.[0]
  const put = (scope: string, key: string, value: unknown, group = '', ready = 0) => {
    catalog.execute({
      kind: 'put',
      scope,
      rows: [
        {
          key,
          value: JSON.stringify(value),
          parent: dirname(key),
          group,
          rank: 0,
          ready
        }
      ]
    })
  }
  const remove = (scope: string, key: string) => catalog.execute({ kind: 'delete', scope, key })
  const observing = `${command.scope}:observing`
  const token = (path: string) => [
    get(files, path)?.value ?? '',
    get(failures, path)?.value ?? '',
    get(`${command.scope}:dirty`, path)?.value ?? ''
  ]
  if (command.kind === 'observe-prepare') {
    const prepared = boundedSessionSearchPage(command.inputs, (input) => {
      const debt = decode<SessionSearchObservationDebt>(get(failures, input.path))
      return {
        ...input,
        force: input.force || !!debt?.force,
        attempt: !debt || (debt.failures < 3 && debt.attempted !== command.generation),
        accepted: decode<SessionSearchObservedFacts>(get(files, input.path)),
        token: JSON.stringify([...token(input.path), catalog.nextRevision()])
      }
    })
    for (const input of prepared) {
      const debt = decode<SessionSearchObservationDebt>(get(failures, input.path))
      if (!input.attempt && debt && (input.force || input.readOwed) && !debt.force) {
        put(
          failures,
          input.path,
          { ...debt, force: true },
          debt.issue ? 'issue' : '',
          Number(debt.failures < 3)
        )
      }
      if (input.attempt) {
        put(observing, input.path, input.token)
      }
    }
    return { prepared }
  }
  let filesDelta = 0,
    failuresDelta = 0,
    runnableDelta = 0
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
    if (next) {
      put(failures, path, next, next.issue ? 'issue' : '', Number(next.failures < 3))
    } else {
      remove(failures, path)
    }
  }
  if (command.kind === 'forget-files') {
    for (const path of command.paths) {
      filesDelta -= Number(!!get(files, path))
      remove(files, path)
      remove(observing, path)
      debtChange(path, decode<SessionSearchObservationDebt>(get(failures, path)), undefined)
      remove(`${command.scope}:dirty`, path)
    }
    return { filesDelta, failuresDelta, runnableDelta }
  }
  for (const outcome of command.outcomes) {
    const current = get(files, outcome.path)
    const expected = JSON.parse(outcome.token)
    if (
      decode<string>(get(observing, outcome.path)) !== outcome.token ||
      JSON.stringify(token(outcome.path)) !== JSON.stringify(expected.slice(0, 3))
    ) {
      continue
    }
    remove(observing, outcome.path)
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
      { file: facts, dependency: outcome.metadataOnly ? undefined : outcome.observed.dependency },
      outcome.metadataOnly ? '' : outcome.observed.dependency
    )
    filesDelta += Number(!accepted)
    const old = accepted?.file
    const same =
      !!old &&
      old.mtimeMs === facts.mtimeMs &&
      old.sizeBytes === facts.sizeBytes &&
      old.dev === facts.dev &&
      old.ino === facts.ino
    observations.push({
      path: outcome.path,
      file: { ...facts, modifiedAt: new Date(facts.mtimeMs).toISOString() },
      changed: force || !same || dependencyChanged,
      force: dependencyChanged || (force && same),
      readable: !unknown
    })
  }
  return { observations, filesDelta, failuresDelta, runnableDelta, missingParents }
}
