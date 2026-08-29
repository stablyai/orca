import { readFileSync } from 'node:fs'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import type { HooksConfig } from './installer-utils'

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export type HooksJsonSnapshot = {
  /** null when the file does not exist or could not be read. */
  raw: string | null
  config: HooksConfig | null
}

export function parseHooksJsonText(raw: string): HooksConfig | null {
  // Why: JSON.parse rejects a decoded UTF-8 BOM; strip only the leading marker.
  const content = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  try {
    const parsed = JSON.parse(content)
    return isPlainObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

// Why: generation guards abort a mutation when the file no longer matches the
// bytes it was derived from; the raw snapshot and the parse must come from one
// read or a concurrent save can slip between them unnoticed.
export function readHooksJsonWithRaw(configPath: string): HooksJsonSnapshot {
  // Why: the read arm below already separates "no hooks configured" from "could
  // not read", but the `existsSync` arm in front of it did not — it returned a
  // VALID EMPTY config for a file that merely could not be opened, and the
  // installer then wrote generated hooks over it. One read classifies both, and
  // closes the TOCTOU window between the two calls.
  try {
    const raw = readFileSync(configPath, 'utf-8')
    return { raw, config: parseHooksJsonText(raw) }
  } catch (error) {
    return isDefinitiveAbsence(error) ? { raw: null, config: {} } : { raw: null, config: null }
  }
}

export function readHooksJson(configPath: string): HooksConfig | null {
  return readHooksJsonWithRaw(configPath).config
}
