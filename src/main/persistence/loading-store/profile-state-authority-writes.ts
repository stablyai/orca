import { createHash } from 'node:crypto'
import {
  applySecretSentinelSubstitutions,
  type SecretSentinelSubstitution
} from './secret-sentinel-substitution'
import type { ProfileStateDomainReplacement } from './profile-state-authority'

export function buildProfileStateDomainReplacements(
  payload: Buffer,
  dirtyDomains: ReadonlySet<string>
): ProfileStateDomainReplacement[] {
  const parsed: unknown = JSON.parse(payload.toString('utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Profile state payload must be a JSON object')
  }
  const entries = new Map(Object.entries(parsed))
  return [...dirtyDomains].map((domain) => {
    if (!entries.has(domain)) {
      return { domain, payload: null }
    }
    const serialized = JSON.stringify(entries.get(domain))
    if (serialized === undefined) {
      throw new Error(`Profile state domain payload is not serializable: ${domain}`)
    }
    return { domain, payload: serialized }
  })
}

export function serializeCompleteProfileStateDomains(
  state: Record<string, unknown>,
  substitutions: readonly SecretSentinelSubstitution[],
  degradedPrefix: string
): { payload: Buffer; stateHash: string; domains: readonly ProfileStateDomainReplacement[] } {
  const domains: ProfileStateDomainReplacement[] = []
  const hash = createHash('sha1').update(degradedPrefix)
  for (const [domain, value] of Object.entries(state)) {
    // The wrapper preserves the original property name passed to a value's toJSON.
    const fragment = JSON.stringify({ [domain]: value })
    if (fragment === '{}') {
      continue
    }
    const serialized = applySecretSentinelSubstitutions(fragment, substitutions, '', 'text')
    hash.update(serialized.stateHash)
    domains.push({
      domain,
      payload: serialized.payload.slice(JSON.stringify(domain).length + 2, -1)
    })
  }
  return {
    domains,
    stateHash: hash.digest('hex'),
    get payload() {
      return Buffer.from(
        `{${domains.map(({ domain, payload }) => `${JSON.stringify(domain)}:${payload}`).join(',')}}`,
        'utf8'
      )
    }
  }
}
