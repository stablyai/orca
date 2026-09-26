import { createHash } from 'node:crypto'
import {
  applySecretSentinelSubstitutions,
  type SecretSentinelSubstitution
} from './secret-sentinel-substitution'
import type { ProfileStateDomainReplacement } from './profile-state-authority'

export function serializeSelectiveProfileStateDomains(
  state: Record<string, unknown>,
  dirtyDomains: ReadonlySet<string>
): ProfileStateDomainReplacement[] {
  const payloads = new Map<string, string>()
  for (const [domain, value] of Object.entries(state)) {
    const fragment = serializeProfileStateDomainFragment(domain, value)
    if (fragment !== '{}') {
      payloads.set(domain, extractProfileStateDomainPayload(domain, fragment))
    }
  }
  return [...dirtyDomains].map((domain) => {
    return { domain, payload: payloads.get(domain) ?? null }
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
    const fragment = serializeProfileStateDomainFragment(domain, value)
    if (fragment === '{}') {
      continue
    }
    const serialized = applySecretSentinelSubstitutions(fragment, substitutions, '', 'text')
    hash.update(serialized.stateHash)
    domains.push({
      domain,
      payload: extractProfileStateDomainPayload(domain, serialized.payload)
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

function serializeProfileStateDomainFragment(domain: string, value: unknown): string {
  // The wrapper preserves the original property name passed to a value's toJSON.
  return JSON.stringify({ [domain]: value })
}

function extractProfileStateDomainPayload(domain: string, fragment: string): string {
  return fragment.slice(JSON.stringify(domain).length + 2, -1)
}
