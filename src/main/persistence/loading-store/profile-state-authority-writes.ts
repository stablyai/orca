import { createHash } from 'node:crypto'
import { types } from 'node:util'
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
  // Capture keys up front, but read values after preceding getters and toJSON hooks.
  for (const domain of Object.keys(state)) {
    const fragment = serializeSelectiveProfileStateDomainFragment(domain, state[domain])
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

function serializeSelectiveProfileStateDomainFragment(domain: string, value: unknown): string {
  let needsNormalization = false
  const fragment = serializeProfileStateDomainFragment(domain, value, (_key, entry) => {
    if (entry !== null && typeof entry === 'object') {
      needsNormalization ||=
        types.isProxy(entry) ||
        ('isRawJSON' in JSON &&
          typeof JSON.isRawJSON === 'function' &&
          JSON.isRawJSON(entry) === true)
    }
    return entry
  })
  // Raw JSON and proxy key order still need the old UTF-8/parse/stringify normalization.
  return needsNormalization ? JSON.stringify(JSON.parse(fragment.toWellFormed())) : fragment
}

function serializeProfileStateDomainFragment(
  domain: string,
  value: unknown,
  replacer?: (key: string, value: unknown) => unknown
): string {
  // The wrapper preserves the original property name passed to a value's toJSON.
  return JSON.stringify({ [domain]: value }, replacer)
}

function extractProfileStateDomainPayload(domain: string, fragment: string): string {
  return fragment.slice(JSON.stringify(domain).length + 2, -1)
}
