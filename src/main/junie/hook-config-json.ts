import { existsSync, readFileSync } from 'node:fs'
import { applyEdits, modify, parse as parseJsonc, type ParseError } from 'jsonc-parser'
import { isPlainObject, type HooksConfig } from '../agent-hooks/installer-utils'

/** Junie parses config.json with kotlinx serialization, which accepts neither comments nor
 *  trailing commas — so this reader is strict too. Tolerating what Junie rejects would report
 *  `installed` for a file whose hooks can never fire, the one status a user cannot debug. */
export function readJunieHooksConfig(configPath: string): HooksConfig | null {
  if (!existsSync(configPath)) {
    return {}
  }

  try {
    const text = readFileSync(configPath, 'utf-8')
    return parseJunieHooksConfigText(text, 'Junie config.json')
  } catch {
    return null
  }
}

/** Original file text alongside its parsed form, so a write can edit the text in place. */
export function readJunieHooksSource(
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
  const config = parseJunieHooksConfigText(text, 'Junie config.json')
  return config === null ? null : { text, config }
}

/**
 * Serialize by editing the original text one hook event at a time, so the user's
 * key order and formatting survive. A parse -> JSON.stringify round trip would
 * silently drop them.
 */
export function serializeJunieHooksConfig(
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
  // Why: touch only the events that actually changed, so a user's own untouched
  // hook entries keep their formatting.
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

export function parseJunieHooksConfigText(
  text: string,
  diagnosticName: string
): HooksConfig | null {
  const errors: ParseError[] = []
  const parsed = parseJsonc(text, errors, {
    disallowComments: true,
    allowTrailingComma: false
  })
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
