import { existsSync, readFileSync } from 'node:fs'
import { applyEdits, modify, parse as parseJsonc, type ParseError } from 'jsonc-parser'
import { isPlainObject, type HooksConfig } from '../agent-hooks/installer-utils'

/** Devin documents config.json as JSONC; stock JSON.parse rejects comments. */
export function readDevinHooksConfig(configPath: string): HooksConfig | null {
  if (!existsSync(configPath)) {
    return {}
  }

  try {
    const text = readFileSync(configPath, 'utf-8')
    return parseDevinHooksConfigText(text, 'Devin config.json')
  } catch {
    return null
  }
}

/** Original file text alongside its parsed form, so a write can edit the text in place. */
export function readDevinHooksSource(
  configPath: string
): { text: string | null; config: HooksConfig } | null {
  if (!existsSync(configPath)) {
    return { text: null, config: {} }
  }

  let text: string
  try {
    text = readFileSync(configPath, 'utf-8')
  } catch {
    return null
  }
  const config = parseDevinHooksConfigText(text, 'Devin config.json')
  return config === null ? null : { text, config }
}

/**
 * Serialize by editing the original JSONC text one hook event at a time, so the user's
 * comments, key order, and formatting survive. A parse -> JSON.stringify round trip would
 * silently drop all of them.
 */
export function serializeDevinHooksConfig(
  originalText: string | null,
  nextConfig: HooksConfig
): string {
  if (originalText === null) {
    return `${JSON.stringify(nextConfig, null, 2)}\n`
  }

  const previous = parseJsonc(originalText) as HooksConfig | undefined
  const previousHooks = isPlainObject(previous?.hooks) ? (previous.hooks ?? {}) : {}
  const nextHooks = nextConfig.hooks ?? {}

  let text = originalText
  // Why: touch only the events that actually changed, so comments attached to a user's
  // own untouched hook entries stay put.
  for (const eventName of new Set([...Object.keys(previousHooks), ...Object.keys(nextHooks)])) {
    const nextValue = nextHooks[eventName]
    if (JSON.stringify(previousHooks[eventName]) === JSON.stringify(nextValue)) {
      continue
    }
    text = applyEdits(
      text,
      // Why: `undefined` removes the key, which is how remove() drops an emptied event.
      modify(text, ['hooks', eventName], nextValue, {
        formattingOptions: { insertSpaces: true, tabSize: 2 }
      })
    )
  }
  return text
}

export function parseDevinHooksConfigText(
  text: string,
  diagnosticName: string
): HooksConfig | null {
  const errors: ParseError[] = []
  const parsed = parseJsonc(text, errors)
  if (errors.length > 0) {
    console.warn(
      `Could not parse ${diagnosticName}: ${errors.map((e) => `offset ${e.offset} length ${e.length}`).join(', ')}`
    )
    return null
  }
  if (parsed === undefined) {
    return null
  }
  return isPlainObject(parsed) ? (parsed as HooksConfig) : null
}

/** Devin imports Claude hooks by default, so surface that overlap explicitly. */
export function readConfigFromOrcaOverlapDetail(
  config: HooksConfig & { read_config_from?: unknown }
): string | null {
  if (!isClaudeConfigImportEnabled(config.read_config_from)) {
    return null
  }

  return 'Devin read_config_from.claude is enabled; imported Claude hooks may fire alongside Devin hooks.'
}

function isClaudeConfigImportEnabled(raw: unknown): boolean {
  if (raw === undefined || raw === null || raw === true) {
    return true
  }
  if (raw === false) {
    return false
  }
  if (Array.isArray(raw)) {
    return raw.includes('claude')
  }
  if (!isPlainObject(raw)) {
    return false
  }
  return raw.claude !== false
}

export function mergeHookInstallDetail(base: string | null, extra: string | null): string | null {
  if (!extra) {
    return base
  }
  if (!base) {
    return extra
  }
  return `${base} ${extra}`
}
