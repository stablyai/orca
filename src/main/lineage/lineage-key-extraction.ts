import vm from 'node:vm'
import { DEFAULT_KEY_REGEX } from '../../shared/lineage-discovery-types'
import { MAX_KEY_REGEX_LENGTH, MAX_TOWER_NAME_LENGTH } from '../../shared/lineage-ticket-keys'

export type ExtractedKeys = { keys: string[]; error?: string }

const USER_REGEX_TIMEOUT_MS = 50
const MAX_CACHED_EXTRACTIONS = 200
const MATCH_SCRIPT = new vm.Script(
  'Array.from(input.matchAll(new RegExp(source, "g")), (match) => match[0])'
)
const extractionCache = new Map<string, ExtractedKeys>()

function toKeys(matches: readonly string[]): string[] {
  // invariant: a regex may match "", and an empty key would match every branch
  return [...new Set(matches.filter(Boolean).map((match) => match.toUpperCase()))]
}

function defaultKeys(text: string): string[] {
  return toKeys(Array.from(text.matchAll(new RegExp(DEFAULT_KEY_REGEX, 'g')), (m) => m[0]))
}

// hazard: a user regex can backtrack catastrophically; the vm timeout is the only hard bound in-process
function runUserRegex(text: string, source: string): string[] {
  const result: unknown = MATCH_SCRIPT.runInNewContext(
    { input: text, source },
    { timeout: USER_REGEX_TIMEOUT_MS }
  )
  if (!Array.isArray(result) || !result.every((item) => typeof item === 'string')) {
    throw new Error('unexpected match result')
  }
  return result
}

function extractUncached(text: string, keyRegex: string): ExtractedKeys {
  if (keyRegex === DEFAULT_KEY_REGEX) {
    return { keys: defaultKeys(text) }
  }
  try {
    if (keyRegex.length === 0 || keyRegex.length > MAX_KEY_REGEX_LENGTH) {
      throw new Error('key pattern length out of range')
    }
    return { keys: toKeys(runUserRegex(text, keyRegex)) }
  } catch {
    return {
      keys: defaultKeys(text),
      error: `Invalid key pattern, using the default: ${keyRegex.slice(0, MAX_KEY_REGEX_LENGTH)}`
    }
  }
}

/** The one place main turns a tower name into keys; bounded in input, time and memory. */
export function extractKeysWithPattern(text: string, keyRegex: string): ExtractedKeys {
  const input = text.slice(0, MAX_TOWER_NAME_LENGTH)
  const cacheKey = `${keyRegex}\u0000${input}`
  const cached = extractionCache.get(cacheKey)
  if (cached) {
    return { ...cached, keys: [...cached.keys] }
  }
  const extracted = extractUncached(input, keyRegex)
  extractionCache.set(cacheKey, extracted)
  if (extractionCache.size > MAX_CACHED_EXTRACTIONS) {
    const oldest = extractionCache.keys().next().value
    if (oldest !== undefined) {
      extractionCache.delete(oldest)
    }
  }
  return { ...extracted, keys: [...extracted.keys] }
}
