import {
  SURFACE_EVIDENCE_PREFIX,
  isSurfaceEvidenceDomain
} from '../../../shared/workspace-surfaces/surface-evidence-document'
import type { ProfileStateDomainReplacement } from '../loading-store/profile-state-authority'
import type { openProfileStateDatabase } from './profile-state-database'
import { parseProfileStateRoot } from './profile-state-document-validation'

export function serializedProfileDomainReplacements(
  payload: Buffer
): ProfileStateDomainReplacement[] {
  const serialized = payload.toString('utf8')
  if (!Buffer.from(serialized, 'utf8').equals(payload)) {
    throw new Error('Profile state payload is not valid UTF-8')
  }
  const parsed = parseProfileStateRoot(serialized)
  return Object.entries(parsed).map(([domain, value]) => {
    const payload = JSON.stringify(value)
    if (payload === undefined) {
      throw new Error(`Profile state domain payload is not serializable: ${domain}`)
    }
    return { domain, payload }
  })
}

export function buildCompleteDocumentReplacements(
  db: ReturnType<typeof openProfileStateDatabase>['db'],
  replacements: readonly ProfileStateDomainReplacement[]
): ProfileStateDomainReplacement[] {
  const domains = new Set(replacements.map(({ domain }) => domain))
  const incoming = new Set(domains)
  for (const row of db
    .prepare(`SELECT domain FROM profile_state_documents
      WHERE domain < ? OR domain >= ?
      UNION SELECT domain FROM profile_state_automation_runs_meta WHERE presence <> 'document'`)
    .all(SURFACE_EVIDENCE_PREFIX, `${SURFACE_EVIDENCE_PREFIX}\uffff`)) {
    if (isDomainRow(row)) {
      domains.add(row.domain)
    }
  }

  return [
    ...replacements,
    ...[...domains]
      .filter((domain) => !incoming.has(domain) && !isSurfaceEvidenceDomain(domain))
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
