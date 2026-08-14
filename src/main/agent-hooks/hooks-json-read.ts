import { existsSync, readFileSync } from 'node:fs'
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
  if (!existsSync(configPath)) {
    return { raw: null, config: {} }
  }
  let raw: string
  try {
    raw = readFileSync(configPath, 'utf-8')
  } catch {
    return { raw: null, config: null }
  }
  return { raw, config: parseHooksJsonText(raw) }
}

export function readHooksJson(configPath: string): HooksConfig | null {
  return readHooksJsonWithRaw(configPath).config
}
