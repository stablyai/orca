import { createHash } from 'node:crypto'
import { types } from 'node:util'
import {
  createTextSecretSentinelSubstituter,
  type SecretSentinelSubstitution
} from './secret-sentinel-substitution'
import type { ProfileStateDomainReplacement } from './profile-state-authority'

const isRawJson =
  'isRawJSON' in JSON && typeof JSON.isRawJSON === 'function' ? JSON.isRawJSON : undefined

function hasCustomToJsonOrProxy(value: unknown): boolean {
  if (value === null || typeof value !== 'object') {
    return false
  }
  return types.isProxy(value) || 'toJSON' in value
}

export function serializeSelectiveProfileStateDomains(
  state: Record<string, unknown>,
  dirtyDomains: ReadonlySet<string>
): ProfileStateDomainReplacement[] {
  const payloads = new Map<string, string>()
  // Read values in order so preceding getters/toJSON hooks can affect later domains.
  for (const domain of Object.keys(state)) {
    const payload = serializeSelectiveProfileStateDomainPayload(domain, state[domain])
    if (payload !== undefined) {
      payloads.set(domain, payload)
    }
  }
  const replacements: ProfileStateDomainReplacement[] = []
  for (const domain of dirtyDomains) {
    replacements.push({ domain, payload: payloads.get(domain) ?? null })
  }
  return replacements
}

export function serializeCompleteProfileStateDomains(
  state: Record<string, unknown>,
  substitutions: readonly SecretSentinelSubstitution[],
  degradedPrefix: string
): { payload: Buffer; stateHash: string; domains: readonly ProfileStateDomainReplacement[] } {
  const domains: ProfileStateDomainReplacement[] = []
  const hash = createHash('sha1').update(degradedPrefix)
  const substituter = createTextSecretSentinelSubstituter(substitutions)
  for (const domain in state) {
    if (!Object.hasOwn(state, domain)) {
      continue
    }
    const value = state[domain]
    if (!hasCustomToJsonOrProxy(value)) {
      const rawPayload = JSON.stringify(value)
      if (rawPayload === undefined) {
        continue
      }
      const serialized = substituter.apply(rawPayload, `{${JSON.stringify(domain)}:`, '}')
      hash.update(serialized.stateHash)
      domains.push({ domain, payload: serialized.payload })
      continue
    }
    const fragment = serializeProfileStateDomainFragment(domain, value)
    if (fragment === '{}') {
      continue
    }
    const serialized = substituter.apply(fragment)
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

function serializeSelectiveProfileStateDomainPayload(
  domain: string,
  value: unknown
): string | undefined {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  let needsNormalization = false
  const replacer = (_key: string, entry: unknown): unknown => {
    if (entry !== null && typeof entry === 'object') {
      needsNormalization ||= types.isProxy(entry) || isRawJson?.(entry) === true
    }
    return entry
  }
  if (!hasCustomToJsonOrProxy(value)) {
    const payload = JSON.stringify(value, replacer)
    if (payload === undefined) {
      return undefined
    }
    // Preserve UTF-8/parse/stringify normalization for raw JSON and proxy key ordering.
    return needsNormalization ? JSON.stringify(JSON.parse(payload.toWellFormed())) : payload
  }
  const fragment = serializeProfileStateDomainFragment(domain, value, replacer)
  if (fragment === '{}') {
    return undefined
  }
  const normalized = needsNormalization
    ? JSON.stringify(JSON.parse(fragment.toWellFormed()))
    : fragment
  return extractProfileStateDomainPayload(domain, normalized)
}

function serializeProfileStateDomainFragment(
  domain: string,
  value: unknown,
  replacer?: (key: string, value: unknown) => unknown
): string {
  // Preserve the domain key observed by value.toJSON.
  return JSON.stringify({ [domain]: value }, replacer)
}

function extractProfileStateDomainPayload(domain: string, fragment: string): string {
  return fragment.slice(JSON.stringify(domain).length + 2, -1)
}
