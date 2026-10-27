// OpenCode 1.x models --verbose emits each provider/model ID followed by indented JSON.

import { z } from 'zod'
import type { AgentSessionModelOption } from '../../shared/agent-session-wire'
import { assertJsonTextStructureWithinLimits } from '../../shared/json-text-structure-limit'

export const OPENCODE_MODEL_LISTING_ARGS = ['models', '--verbose'] as const

// The default sentinel means no variant override.
const DEFAULT_VARIANT = 'default'
const MODEL_JSON_LIMITS = { structuralTokens: 64 * 1024, nestingDepth: 32 } as const

const modelMetaSchema = z.looseObject({
  name: z.string().min(1).optional(),
  variants: z.record(z.string(), z.unknown()).optional()
})

function variantLabel(variant: string): string {
  return variant
    .split(/[_-]/)
    .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join(' ')
}

function modelOption(id: string, metadata: unknown): AgentSessionModelOption {
  const meta = modelMetaSchema.safeParse(metadata)
  const name = meta.success ? meta.data.name : undefined
  const variants = meta.success ? Object.keys(meta.data.variants ?? {}) : []
  const providerId = id.slice(0, id.indexOf('/'))
  return {
    id,
    label: name ? `${providerId}/${name}` : id,
    // Listing proves availability, not the configured default.
    isDefault: false,
    ...(variants.length > 0
      ? {
          efforts: [...new Set([...variants, DEFAULT_VARIANT])].map((value) => ({
            value,
            label: variantLabel(value)
          })),
          // New OpenCode sessions use default when offered, otherwise the first variant.
          defaultEffort: variants.includes(DEFAULT_VARIANT) ? DEFAULT_VARIANT : variants[0]
        }
      : { efforts: [] })
  }
}

function isModelIdLine(line: string): boolean {
  const slash = line.indexOf('/')
  return slash > 0 && slash < line.length - 1 && !/\s/.test(line) && !line.startsWith('{')
}

/** Retain model IDs even when malformed metadata prevents an effort menu. */
export function parseOpenCodeModelListing(stdout: string): AgentSessionModelOption[] {
  const lines = stdout.split(/\r?\n/)
  const models = new Map<string, AgentSessionModelOption>()
  // Pretty-printed objects end at a bare closing brace; empty objects fit on one line.
  const closesObject = (line: string, first: boolean): boolean =>
    line.trimEnd() === '}' || (first && line.trimEnd() === '{}')
  for (let index = 0; index < lines.length; index++) {
    const id = (lines[index] ?? '').trim()
    if (!isModelIdLine(id)) {
      continue
    }
    let metadata: unknown
    if (lines[index + 1]?.startsWith('{')) {
      const start = index + 1
      let end = start
      while (end < lines.length && !closesObject(lines[end] ?? '', end === start)) {
        end++
      }
      const text = lines.slice(start, end + 1).join('\n')
      index = end
      try {
        assertJsonTextStructureWithinLimits(text, MODEL_JSON_LIMITS)
        metadata = JSON.parse(text)
      } catch {
        metadata = undefined
      }
    }
    if (!models.has(id)) {
      models.set(id, modelOption(id, metadata))
    }
  }
  return [...models.values()]
}
