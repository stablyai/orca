// Fold `agy models` rows to match the base IDs and `thought_level` menus `agy acp` exposes.

import type { AgentSessionModelOption } from '../../shared/agent-session/agent-session-wire'
import {
  CLAUDE_THINKING_LEVELS,
  parseAntigravityModels
} from '../../shared/source-control/ai/generation/commit-message-model-parsers'

export const ANTIGRAVITY_MODEL_LISTING_ARGS = ['models'] as const

const EFFORT_LABEL_SUFFIX: Readonly<Record<string, RegExp>> = {
  low: /\s+\(low\)$/i,
  medium: /\s+\(medium\)$/i,
  high: /\s+\(high\)$/i,
  xhigh: /\s+\((?:extra high|xhigh)\)$/i,
  max: /\s+\(max\)$/i
}

type VariantRow = {
  rawId: string
  rawLabel: string
  baseLabel: string
}

type ModelFamily = {
  bareLabel?: string
  variants: Map<string, VariantRow>
}

function splitEffortVariant(
  id: string,
  label: string
): { baseId: string; baseLabel: string; effortId: string } | null {
  for (const level of CLAUDE_THINKING_LEVELS) {
    const suffix = `-${level.id}`
    if (!id.endsWith(suffix) || id.length <= suffix.length) {
      continue
    }
    const baseId = id.slice(0, -suffix.length)
    const labelMatch = EFFORT_LABEL_SUFFIX[level.id]?.exec(label)
    if (labelMatch && labelMatch.index > 0) {
      const baseLabel = label.slice(0, labelMatch.index).trim()
      if (baseLabel) {
        return { baseId, baseLabel, effortId: level.id }
      }
    }
    if (label === id) {
      return { baseId, baseLabel: baseId, effortId: level.id }
    }
    return null
  }
  return null
}

export function parseAntigravityModelCatalogListing(stdout: string): AgentSessionModelOption[] {
  const families = new Map<string, ModelFamily>()
  for (const { id, label } of parseAntigravityModels(stdout)) {
    if (/\s/.test(id)) {
      continue
    }
    const variant = splitEffortVariant(id, label)
    if (!variant) {
      const existing: ModelFamily = families.get(id) ?? { variants: new Map() }
      existing.bareLabel ??= label
      families.set(id, existing)
      continue
    }
    const existing: ModelFamily = families.get(variant.baseId) ?? { variants: new Map() }
    if (!existing.variants.has(variant.effortId)) {
      existing.variants.set(variant.effortId, {
        rawId: id,
        rawLabel: label,
        baseLabel: variant.baseLabel
      })
    }
    families.set(variant.baseId, existing)
  }

  const models: AgentSessionModelOption[] = []
  for (const [baseId, family] of families) {
    // Single-variant models (such as gpt-oss-120b-medium) stay literal in `agy acp` with no effort selector.
    if (family.variants.size === 1 && family.bareLabel === undefined) {
      const [only] = family.variants.values()
      if (only) {
        models.push({
          id: only.rawId,
          label: only.rawLabel,
          isDefault: false,
          efforts: []
        })
      }
      continue
    }
    if (family.variants.size === 0) {
      if (family.bareLabel !== undefined) {
        models.push({
          id: baseId,
          label: family.bareLabel,
          isDefault: false,
          efforts: []
        })
      }
      continue
    }
    const firstVariant = family.variants.values().next().value
    const label = family.bareLabel ?? firstVariant?.baseLabel ?? baseId
    const efforts = CLAUDE_THINKING_LEVELS.filter((level) => family.variants.has(level.id)).map(
      (level) => ({
        value: level.id,
        label: level.label
      })
    )
    models.push({
      id: baseId,
      label,
      isDefault: false,
      efforts
    })
  }
  return models
}
