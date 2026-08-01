import type { RuntimeWorktreeAgentContextPressure } from '../../../src/shared/runtime-types'

type PressureLevel = RuntimeWorktreeAgentContextPressure['level']
type LimitSource = NonNullable<RuntimeWorktreeAgentContextPressure['limitSource']>

export type ContextPressureCopy = {
  title: string
  hint: string
  windowLabel: string
  approximate: string
  tokens: string
  used: string
  effectiveLimit: string
  levels: Record<PressureLevel, string>
  limitSources: Record<LimitSource, string>
}

// Why: mobile UI is English-only today; no locale table until mobile grows a real i18n layer.
export const CONTEXT_PRESSURE_COPY: ContextPressureCopy = {
  title: 'Context window',
  hint: 'Shows context window details',
  windowLabel: 'Context window',
  approximate: 'approximately',
  tokens: 'tokens',
  used: 'used',
  effectiveLimit: 'Effective limit',
  levels: { ok: 'healthy', warning: 'approaching limit', critical: 'near limit' },
  limitSources: {
    'soft-cap': 'soft cap',
    model: 'model maximum',
    provider: 'provider-reported'
  }
}
