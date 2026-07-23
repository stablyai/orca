import { existsSync } from 'node:fs'
import { readNodeFileSyncWithinLimit } from '../../shared/node-bounded-file-reader'
import { assertJsonTextStructureWithinLimits } from '../../shared/json-text-structure-limit'
import type { HooksConfig } from './installer-utils'
import {
  AGENT_HOOK_CONFIG_MAX_BYTES,
  AGENT_HOOK_CONFIG_MAX_NESTING_DEPTH,
  AGENT_HOOK_CONFIG_MAX_STRUCTURAL_TOKENS
} from './agent-hook-file-limits'

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export type HooksJsonSnapshot = {
  /** null when the file does not exist or could not be read. */
  raw: string | null
  config: HooksConfig | null
}

export function parseHooksJsonText(raw: string): HooksConfig | null {
  try {
    assertJsonTextStructureWithinLimits(raw, {
      structuralTokens: AGENT_HOOK_CONFIG_MAX_STRUCTURAL_TOKENS,
      nestingDepth: AGENT_HOOK_CONFIG_MAX_NESTING_DEPTH
    })
    const parsed = JSON.parse(raw)
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
    raw = readNodeFileSyncWithinLimit(configPath, AGENT_HOOK_CONFIG_MAX_BYTES).buffer.toString(
      'utf8'
    )
  } catch {
    return { raw: null, config: null }
  }
  return { raw, config: parseHooksJsonText(raw) }
}

export function readHooksJson(configPath: string): HooksConfig | null {
  return readHooksJsonWithRaw(configPath).config
}

export function readHooksJsonRawForGenerationCheck(configPath: string): string {
  return readNodeFileSyncWithinLimit(configPath, AGENT_HOOK_CONFIG_MAX_BYTES).buffer.toString(
    'utf8'
  )
}
