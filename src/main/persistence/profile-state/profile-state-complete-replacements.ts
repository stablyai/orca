import type { ProfileStateDomainReplacement } from '../loading-store/profile-state-authority'
import type { openProfileStateDatabase } from './profile-state-database'

export function buildCompleteDocumentReplacements(
  db: ReturnType<typeof openProfileStateDatabase>['db'],
  replacements: readonly ProfileStateDomainReplacement[]
): ProfileStateDomainReplacement[] {
  const domains = new Set(replacements.map(({ domain }) => domain))
  const incoming = new Set(domains)
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
