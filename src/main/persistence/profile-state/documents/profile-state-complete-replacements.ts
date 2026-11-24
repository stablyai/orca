import type { ProfileStateDomainReplacement } from '../../loading-store/profile-writing/profile-state-authority'
import type { openProfileStateDatabase } from '../database/profile-state-database'
import { isRecord, parseProfileStateRoot } from './profile-state-document-validation'
import {
  prepareProfileStateDomainPatches,
  type ProfileStateDomainPatch
} from './profile-state-domain-patches'

/** Validates every patch's domain and shape; an empty one only marks its domain present, so only
 *  changed ones apply, and their operations are parsed once, by the transaction. */
export function changedSessionPatches(
  patches: readonly ProfileStateDomainPatch[]
): ProfileStateDomainPatch[] {
  prepareProfileStateDomainPatches(
    patches.map((patch: unknown) =>
      isRecord(patch) && Array.isArray(patch.operations) ? { ...patch, operations: [] } : patch
    )
  )
  return patches.filter(({ operations }) => operations.length > 0)
}

/** Splices domain fragments into one document; null payloads are omitted. */
export function spliceProfileStateFragments(
  fragments: readonly ProfileStateDomainReplacement[]
): string {
  const present = fragments.filter(({ payload }) => payload !== null)
  return `{${present.map(({ domain, payload }) => `${JSON.stringify(domain)}:${payload}`).join(',')}}`
}

/** One whole-document payload as per-domain replacements. */
export function splitProfileStatePayload(payload: Buffer): ProfileStateDomainReplacement[] {
  const serialized = payload.toString('utf8')
  if (!Buffer.from(serialized, 'utf8').equals(payload)) {
    throw new Error('Profile state payload is not valid UTF-8')
  }
  return Object.entries(parseProfileStateRoot(serialized)).map(([domain, value]) => {
    const domainPayload = JSON.stringify(value)
    if (domainPayload === undefined) {
      throw new Error(`Profile state domain payload is not serializable: ${domain}`)
    }
    return { domain, payload: domainPayload }
  })
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
