import {
  type JsonRecord,
  record
} from '../../shared/agent-hook-listener/providers/codex/codex-rollout-jsonl-format'
import { extractString } from '../../shared/text/trimmed-string'
import { parse as parseToml } from 'smol-toml'

/** Per-million-token rates, as Vibe writes them in config.toml. */
export type VibeModelPricing = {
  input: number
  cachedInput: number
  output: number
}

type VibeModelEntry = {
  alias: string | null
  name: string | null
  rates: VibeModelPricing
}

function toRate(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function toRates(model: JsonRecord): VibeModelPricing | null {
  const input = toRate(model.input_price)
  const output = toRate(model.output_price)
  if (input === null || output === null) {
    return null
  }
  return { input, cachedInput: toRate(model.cached_input_price) ?? input, output }
}

/** Vibe accepts `[[models]]` lists and `[models.<alias>]` maps, where the map key is the alias. */
function collectModelEntries(models: unknown): VibeModelEntry[] {
  const entries: VibeModelEntry[] = []
  if (Array.isArray(models)) {
    for (const raw of models) {
      const model = record(raw)
      const rates = model ? toRates(model) : null
      if (model && rates) {
        entries.push({ alias: extractString(model.alias), name: extractString(model.name), rates })
      }
    }
    return entries
  }
  const byAlias = record(models)
  if (!byAlias) {
    return entries
  }
  for (const [key, raw] of Object.entries(byAlias)) {
    const model = record(raw)
    const rates = model ? toRates(model) : null
    if (!model || !rates) {
      continue
    }
    entries.push({ alias: key, name: extractString(model.name), rates })
    const explicitAlias = extractString(model.alias)
    if (explicitAlias && explicitAlias !== key) {
      entries.push({ alias: explicitAlias, name: null, rates })
    }
  }
  return entries
}

/**
 * Vibe prices models in config.toml. Entries that omit prices fall back to Vibe's built-in
 * catalogue, which Orca cannot read, so they stay unpriced here.
 */
export function parseVibeModelPricing(text: string): Map<string, VibeModelPricing> {
  const pricing = new Map<string, VibeModelPricing>()
  let parsed: unknown
  try {
    parsed = parseToml(text)
  } catch {
    return pricing
  }
  const entries = collectModelEntries(record(parsed)?.models)
  // Vibe selects models by alias, so a name fallback must never replace an alias entry.
  for (const entry of entries) {
    if (entry.alias) {
      pricing.set(entry.alias, entry.rates)
    }
  }
  for (const entry of entries) {
    if (entry.name && !pricing.has(entry.name)) {
      pricing.set(entry.name, entry.rates)
    }
  }
  return pricing
}
