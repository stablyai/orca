import { readFileSync } from 'node:fs'
import { applyEdits, modify, parse as parseJsonc, type ParseError } from 'jsonc-parser'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { isPlainObject } from '../agent-hooks/installer-utils'
import { isZCodeHooksEnabled, readZCodeEventMap, type ZCodeConfig } from './hook-settings'

export type ZCodeConfigSource = {
  text: string | null
  config: ZCodeConfig
}

export function parseZCodeConfigText(text: string, diagnosticName: string): ZCodeConfig | null {
  const errors: ParseError[] = []
  const parsed = parseJsonc(text, errors)
  if (errors.length > 0) {
    console.warn(
      `Could not parse ${diagnosticName}: ${errors.map((e) => `offset ${e.offset} length ${e.length}`).join(', ')}`
    )
    return null
  }
  if (parsed === undefined) {
    return {}
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: isPlainObject just proved this is a plain object; ZCodeConfig only adds optional keys over its index signature.
  return isPlainObject(parsed) ? (parsed as ZCodeConfig) : null
}

export function readZCodeConfigSource(configPath: string): ZCodeConfigSource | null {
  let text: string
  try {
    text = readFileSync(configPath, 'utf-8')
  } catch (error) {
    // Only definitive absence is a fresh install; unreadable files must never be replaced by stub configs.
    return isDefinitiveAbsence(error) ? { text: null, config: {} } : null
  }
  const config = parseZCodeConfigText(text, 'ZCode config.json')
  return config === null ? null : { text, config }
}

const JSON_EDIT_FORMATTING = { formattingOptions: { insertSpaces: true, tabSize: 2 } } as const

/** Undefined removes the JSON key. */
function editJsonPath(text: string, path: readonly string[], value: unknown): string {
  return applyEdits(text, modify(text, [...path], value, JSON_EDIT_FORMATTING))
}

/** Edit original JSON text so user key order/indentation survive. ZCode uses strict JSON.parse, so JSONC comments are unsupported. */
export function serializeZCodeConfig(originalText: string | null, nextConfig: ZCodeConfig): string {
  if (originalText === null) {
    return `${JSON.stringify(nextConfig, null, 2)}\n`
  }

  const previous = parseZCodeConfigText(originalText, 'ZCode config.json') ?? {}
  const previousEvents = readZCodeEventMap(previous)
  const nextEvents = readZCodeEventMap(nextConfig)

  let text = originalText
  const nextEnabled = isZCodeHooksEnabled(nextConfig)
  if (isZCodeHooksEnabled(previous) !== nextEnabled) {
    text = editJsonPath(text, ['hooks', 'enabled'], nextEnabled)
  }
  // Edit only changed events so unrelated user hook formatting stays untouched.
  for (const eventName of new Set([...Object.keys(previousEvents), ...Object.keys(nextEvents)])) {
    const nextValue = nextEvents[eventName]
    if (JSON.stringify(previousEvents[eventName]) === JSON.stringify(nextValue)) {
      continue
    }
    text = editJsonPath(text, ['hooks', 'events', eventName], nextValue)
  }
  return text
}
