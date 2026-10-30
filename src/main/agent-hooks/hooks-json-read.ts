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
  // JSON.parse rejects a decoded UTF-8 BOM.
  const content = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  try {
    const parsed = JSON.parse(content)
    return isPlainObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

// Generation guards need raw bytes and parsed config from the same read to detect concurrent saves.
export function readHooksJsonWithRaw(configPath: string): HooksJsonSnapshot {
  // Only confirmed absence permits an empty config; unreadable files must not be overwritten.
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
