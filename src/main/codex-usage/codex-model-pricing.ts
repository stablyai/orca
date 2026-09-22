export type TieredPrice = { threshold: number; price: number }
export type CodexModelPricing = {
  input: number
  cachedInput: number
  output: number
  inputTiers?: TieredPrice[]
  cachedInputTiers?: TieredPrice[]
  outputTiers?: TieredPrice[]
}

const LONG_CONTEXT_THRESHOLD_TOKENS = 272_000

export const MODEL_PRICING: Record<string, CodexModelPricing> = {
  'gpt-5': { input: 1.25, cachedInput: 0.125, output: 10 },
  'gpt-5.1': { input: 1.25, cachedInput: 0.125, output: 10 },
  'gpt-5.1-codex': { input: 1.25, cachedInput: 0.125, output: 10 },
  'gpt-5.1-codex-max': { input: 1.25, cachedInput: 0.125, output: 10 },
  'gpt-5.2': { input: 1.75, cachedInput: 0.175, output: 14 },
  'gpt-5.2-pro': { input: 21, cachedInput: 21, output: 168 },
  'gpt-5.2-codex': { input: 1.75, cachedInput: 0.175, output: 14 },
  'gpt-5.3': { input: 1.75, cachedInput: 0.175, output: 14 },
  'gpt-5.3-codex': { input: 1.75, cachedInput: 0.175, output: 14 },
  'gpt-5.3-codex-spark': { input: 1.75, cachedInput: 0.175, output: 14 },
  'gpt-5.4-mini': { input: 0.75, cachedInput: 0.075, output: 4.5 },
  'gpt-5.4-nano': { input: 0.2, cachedInput: 0.02, output: 1.25 },
  'gpt-5.4-pro': {
    input: 30,
    cachedInput: 30,
    output: 180,
    inputTiers: [{ threshold: LONG_CONTEXT_THRESHOLD_TOKENS, price: 60 }],
    cachedInputTiers: [{ threshold: LONG_CONTEXT_THRESHOLD_TOKENS, price: 60 }],
    outputTiers: [{ threshold: LONG_CONTEXT_THRESHOLD_TOKENS, price: 270 }]
  },
  'gpt-5.4': {
    input: 2.5,
    cachedInput: 0.25,
    output: 15,
    inputTiers: [{ threshold: LONG_CONTEXT_THRESHOLD_TOKENS, price: 5 }],
    cachedInputTiers: [{ threshold: LONG_CONTEXT_THRESHOLD_TOKENS, price: 0.5 }],
    outputTiers: [{ threshold: LONG_CONTEXT_THRESHOLD_TOKENS, price: 22.5 }]
  },
  'gpt-5.5-pro': {
    input: 30,
    cachedInput: 30,
    output: 180,
    inputTiers: [{ threshold: LONG_CONTEXT_THRESHOLD_TOKENS, price: 60 }],
    cachedInputTiers: [{ threshold: LONG_CONTEXT_THRESHOLD_TOKENS, price: 60 }],
    outputTiers: [{ threshold: LONG_CONTEXT_THRESHOLD_TOKENS, price: 270 }]
  },
  'gpt-5.5': {
    input: 5,
    cachedInput: 0.5,
    output: 30,
    inputTiers: [{ threshold: LONG_CONTEXT_THRESHOLD_TOKENS, price: 10 }],
    cachedInputTiers: [{ threshold: LONG_CONTEXT_THRESHOLD_TOKENS, price: 1 }],
    outputTiers: [{ threshold: LONG_CONTEXT_THRESHOLD_TOKENS, price: 45 }]
  },
  // Why: Sol's $4/$20 is OpenAI's promotional rate, listed through at least 2026-11-21.
  'gpt-5.6-sol': {
    input: 4,
    cachedInput: 0.4,
    output: 20,
    inputTiers: [{ threshold: LONG_CONTEXT_THRESHOLD_TOKENS, price: 8 }],
    cachedInputTiers: [{ threshold: LONG_CONTEXT_THRESHOLD_TOKENS, price: 0.8 }],
    outputTiers: [{ threshold: LONG_CONTEXT_THRESHOLD_TOKENS, price: 30 }]
  },
  'gpt-5.6-terra': {
    input: 2,
    cachedInput: 0.2,
    output: 12,
    inputTiers: [{ threshold: LONG_CONTEXT_THRESHOLD_TOKENS, price: 4 }],
    cachedInputTiers: [{ threshold: LONG_CONTEXT_THRESHOLD_TOKENS, price: 0.4 }],
    outputTiers: [{ threshold: LONG_CONTEXT_THRESHOLD_TOKENS, price: 18 }]
  },
  'gpt-5.6-luna': {
    input: 0.2,
    cachedInput: 0.02,
    output: 1.2,
    inputTiers: [{ threshold: LONG_CONTEXT_THRESHOLD_TOKENS, price: 0.4 }],
    cachedInputTiers: [{ threshold: LONG_CONTEXT_THRESHOLD_TOKENS, price: 0.04 }],
    outputTiers: [{ threshold: LONG_CONTEXT_THRESHOLD_TOKENS, price: 1.8 }]
  },
  'gpt-6-astra': {
    input: 10,
    cachedInput: 1,
    output: 50,
    inputTiers: [{ threshold: LONG_CONTEXT_THRESHOLD_TOKENS, price: 20 }],
    cachedInputTiers: [{ threshold: LONG_CONTEXT_THRESHOLD_TOKENS, price: 2 }],
    outputTiers: [{ threshold: LONG_CONTEXT_THRESHOLD_TOKENS, price: 75 }]
  },
  'gpt-6-sol': {
    input: 2,
    cachedInput: 0.2,
    output: 10,
    inputTiers: [{ threshold: LONG_CONTEXT_THRESHOLD_TOKENS, price: 4 }],
    cachedInputTiers: [{ threshold: LONG_CONTEXT_THRESHOLD_TOKENS, price: 0.4 }],
    outputTiers: [{ threshold: LONG_CONTEXT_THRESHOLD_TOKENS, price: 15 }]
  },
  'gpt-6-luna': {
    input: 0.1,
    cachedInput: 0.01,
    output: 0.5,
    inputTiers: [{ threshold: LONG_CONTEXT_THRESHOLD_TOKENS, price: 0.2 }],
    cachedInputTiers: [{ threshold: LONG_CONTEXT_THRESHOLD_TOKENS, price: 0.02 }],
    outputTiers: [{ threshold: LONG_CONTEXT_THRESHOLD_TOKENS, price: 0.75 }]
  }
}

const REASONING_TIER_SUFFIXES = ['minimal', 'low', 'medium', 'high', 'xhigh', 'auto', 'none']
// Why: `max`/`ultra` only in parentheses — as a dash suffix `max` would strip `gpt-5.1-codex-max`.
const PARENTHESIZED_REASONING_TIERS = [...REASONING_TIER_SUFFIXES, 'max', 'ultra']

function stripParenthesizedReasoningTier(model: string): string | null {
  const match = model.match(/^(.*)\(([^()]*)\)$/)
  if (!match) {
    return model
  }
  const tier = match[2].trim().toLowerCase()
  if (!PARENTHESIZED_REASONING_TIERS.includes(tier)) {
    return null
  }
  return match[1]
}

function stripDashReasoningTiers(model: string): string {
  let current = model
  for (let index = 0; index < 4; index++) {
    const suffix = REASONING_TIER_SUFFIXES.find((tier) => current.endsWith(`-${tier}`))
    if (!suffix) {
      return current
    }
    current = current.slice(0, -suffix.length - 1)
  }
  return current
}

export function normalizeModelForPricing(model: string | null): string | null {
  if (!model) {
    return null
  }

  const lower = stripParenthesizedReasoningTier(model.toLowerCase().trim())
  if (!lower) {
    return null
  }

  const normalized = stripDashReasoningTiers(lower)
  if (normalized === 'gpt-5' || normalized === 'gpt-5-codex') {
    return 'gpt-5'
  }
  if (normalized === 'gpt-5.1-codex-max' || normalized.startsWith('gpt-5.1-codex-max-')) {
    return 'gpt-5.1-codex-max'
  }
  if (normalized === 'gpt-5.1-codex' || normalized.startsWith('gpt-5.1-codex-')) {
    return 'gpt-5.1-codex'
  }
  if (normalized === 'gpt-5.1' || normalized.startsWith('gpt-5.1-')) {
    return 'gpt-5.1'
  }
  if (normalized === 'gpt-5.2-pro' || normalized.startsWith('gpt-5.2-pro-')) {
    return 'gpt-5.2-pro'
  }
  if (normalized === 'gpt-5.2-codex' || normalized.startsWith('gpt-5.2-codex-')) {
    return 'gpt-5.2-codex'
  }
  if (normalized === 'gpt-5.2' || normalized.startsWith('gpt-5.2-')) {
    return 'gpt-5.2'
  }
  if (normalized === 'gpt-5.3-codex-spark' || normalized.startsWith('gpt-5.3-codex-spark-')) {
    return 'gpt-5.3-codex-spark'
  }
  if (normalized === 'gpt-5.3-codex' || normalized.startsWith('gpt-5.3-codex-')) {
    return 'gpt-5.3-codex'
  }
  if (normalized === 'gpt-5.3' || normalized.startsWith('gpt-5.3-')) {
    return 'gpt-5.3'
  }
  if (normalized === 'gpt-5.4-mini' || normalized.startsWith('gpt-5.4-mini-')) {
    return 'gpt-5.4-mini'
  }
  if (normalized === 'gpt-5.4-nano' || normalized.startsWith('gpt-5.4-nano-')) {
    return 'gpt-5.4-nano'
  }
  if (normalized === 'gpt-5.4-pro' || normalized.startsWith('gpt-5.4-pro-')) {
    return 'gpt-5.4-pro'
  }
  if (normalized === 'gpt-5.4' || normalized.startsWith('gpt-5.4-')) {
    return 'gpt-5.4'
  }
  if (normalized === 'gpt-5.5-pro' || normalized.startsWith('gpt-5.5-pro-')) {
    return 'gpt-5.5-pro'
  }
  if (normalized === 'gpt-5.5' || normalized.startsWith('gpt-5.5-')) {
    return 'gpt-5.5'
  }
  if (normalized === 'gpt-5.6-sol' || normalized.startsWith('gpt-5.6-sol-')) {
    return 'gpt-5.6-sol'
  }
  if (normalized === 'gpt-5.6-terra' || normalized.startsWith('gpt-5.6-terra-')) {
    return 'gpt-5.6-terra'
  }
  if (normalized === 'gpt-5.6-luna' || normalized.startsWith('gpt-5.6-luna-')) {
    return 'gpt-5.6-luna'
  }
  if (normalized === 'gpt-6-astra' || normalized.startsWith('gpt-6-astra-')) {
    return 'gpt-6-astra'
  }
  if (normalized === 'gpt-6-sol' || normalized.startsWith('gpt-6-sol-')) {
    return 'gpt-6-sol'
  }
  if (normalized === 'gpt-6-luna' || normalized.startsWith('gpt-6-luna-')) {
    return 'gpt-6-luna'
  }
  // Why: OpenAI routes the bare `gpt-5.6` alias to Sol. Match it exactly — a
  // `gpt-5.6-` prefix match would swallow the tier IDs above and any future
  // cheaper variant.
  if (normalized === 'gpt-5.6') {
    return 'gpt-5.6-sol'
  }
  return null
}
