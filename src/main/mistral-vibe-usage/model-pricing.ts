import { record } from '../../shared/codex-rollout-jsonl-cursor'
import { extractString } from '../../shared/trimmed-string'
import { parse as parseToml } from 'smol-toml'

/** Per-million-token rates, as Vibe writes them in config.toml. */
export type VibeModelPricing = {
  input: number
  cachedInput: number
  output: number
}

function toRate(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/**
 * Vibe prices models in `[[models]]` entries of config.toml. Entries that omit prices fall back to
 * Vibe's built-in catalogue, which Orca cannot read, so they stay unpriced here.
 */
export function parseVibeModelPricing(text: string): Map<string, VibeModelPricing> {
  const pricing = new Map<string, VibeModelPricing>()
  let parsed: unknown
  try {
    parsed = parseToml(text)
  } catch {
    return pricing
  }
  const models = record(parsed)?.models
  if (!Array.isArray(models)) {
    return pricing
  }
  for (const entry of models) {
    const model = record(entry)
    if (!model) {
      continue
    }
    const input = toRate(model.input_price)
    const output = toRate(model.output_price)
    if (input === null || output === null) {
      continue
    }
    const rates: VibeModelPricing = {
      input,
      cachedInput: toRate(model.cached_input_price) ?? input,
      output
    }
    for (const key of [extractString(model.alias), extractString(model.name)]) {
      if (key) {
        pricing.set(key, rates)
      }
    }
  }
  return pricing
}
