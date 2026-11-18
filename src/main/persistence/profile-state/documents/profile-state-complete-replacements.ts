import type { ProfileStateDomainReplacement } from '../../loading-store/profile-writing/profile-state-authority'
import type { openProfileStateDatabase } from '../database/profile-state-database'
import { importProfileStateJson } from './profile-state-documents'
import { prepareProfileStateDomainMutation } from './profile-state-domain-write-validation'

/** Seeds an empty database from whole fragments; returns the new revision. */
export function importCompleteDocument(
  db: ReturnType<typeof openProfileStateDatabase>['db'],
  replacements: readonly ProfileStateDomainReplacement[],
  expectedRevision: number | undefined
): number {
  // Validate fragments independently so splicing cannot conceal malformed JSON.
  for (const replacement of replacements) {
    prepareProfileStateDomainMutation(replacement)
  }
  const rawJson = `{${replacements
    .filter(({ payload }) => payload !== null)
    .map(({ domain, payload }) => `${JSON.stringify(domain)}:${payload}`)
    .join(',')}}`
  return importProfileStateJson(db, rawJson, { expectedRevision })
}

export function buildCompleteDocumentReplacements(
  db: ReturnType<typeof openProfileStateDatabase>['db'],
  replacements: readonly ProfileStateDomainReplacement[],
  /** Present domains sent as patches rather than whole payloads. */
  patched: readonly { domain: string }[] = []
): ProfileStateDomainReplacement[] {
  const domains = new Set(replacements.map(({ domain }) => domain))
  const incoming = new Set([...domains, ...patched.map(({ domain }) => domain)])
  for (const row of db
    .prepare(`SELECT domain FROM profile_state_documents
      UNION SELECT domain FROM profile_state_automation_runs_meta WHERE presence <> 'document'`)
    .all()) {
    if (isDomainRow(row)) {
      domains.add(row.domain)
    }
  }

  return [
    ...replacements,
    ...[...domains]
      .filter((domain) => !incoming.has(domain))
      .map((domain) => ({ domain, payload: null }))
  ]
}

function isDomainRow(value: unknown): value is { domain: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'domain' in value &&
    typeof value.domain === 'string' &&
    value.domain.length > 0
  )
}
