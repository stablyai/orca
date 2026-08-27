export type GeminiModelPricing = {
  input: number
  cachedInput: number
  output: number
  thresholdTokens?: number
  inputAboveThreshold?: number
  cachedInputAboveThreshold?: number
  outputAboveThreshold?: number
}

const LONG_CONTEXT_THRESHOLD_TOKENS = 200_000

const PRO_TIERED_PRICING: GeminiModelPricing = {
  input: 1.25,
  cachedInput: 0.3125,
  output: 10,
  thresholdTokens: LONG_CONTEXT_THRESHOLD_TOKENS,
  inputAboveThreshold: 2.5,
  cachedInputAboveThreshold: 0.625,
  outputAboveThreshold: 15
}

const FLASH_TIERED_PRICING: GeminiModelPricing = {
  input: 0.075,
  cachedInput: 0.01875,
  output: 0.3,
  thresholdTokens: LONG_CONTEXT_THRESHOLD_TOKENS,
  inputAboveThreshold: 0.15,
  cachedInputAboveThreshold: 0.0375,
  outputAboveThreshold: 0.6
}

const FLASH_LITE_PRICING: GeminiModelPricing = {
  input: 0.0375,
  cachedInput: 0.01,
  output: 0.15
}

export const MODEL_PRICING: Record<string, GeminiModelPricing> = {
  'gemini-3.1-pro': PRO_TIERED_PRICING,
  'gemini-3.1-flash': FLASH_TIERED_PRICING,
  'gemini-3.1-flash-lite': FLASH_LITE_PRICING,
  'gemini-3.0-pro': PRO_TIERED_PRICING,
  'gemini-3.0-flash': FLASH_TIERED_PRICING,
  'gemini-3-pro-preview': PRO_TIERED_PRICING,
  'gemini-3-flash-preview': FLASH_TIERED_PRICING,
  'gemini-2.5-pro': PRO_TIERED_PRICING,
  'gemini-2.5-flash': FLASH_TIERED_PRICING,
  'gemini-2.5-flash-lite': FLASH_LITE_PRICING,
  'gemini-2.0-pro': PRO_TIERED_PRICING,
  'gemini-2.0-flash': FLASH_TIERED_PRICING,
  'gemini-2.0-flash-lite': FLASH_LITE_PRICING,
  'gemini-1.5-pro': PRO_TIERED_PRICING,
  'gemini-1.5-flash': FLASH_TIERED_PRICING,
  'gemini-exp': PRO_TIERED_PRICING,
  'gemini-experimental': PRO_TIERED_PRICING,
  'gemini-ultra': {
    input: 2.5,
    cachedInput: 0.625,
    output: 10
  }
}

const MODEL_ALIASES: Record<string, string> = {
  'gemini-pro': 'gemini-2.5-pro',
  'gemini-flash': 'gemini-2.5-flash',
  'gemini-3': 'gemini-3.0-pro',
  'gemini-3-pro': 'gemini-3.0-pro',
  'gemini-3-flash': 'gemini-3.0-flash',
  'gemini-3.7-flash': 'gemini-3.1-flash',
  'gemini-3.7-pro': 'gemini-3.1-pro',
  'gemini-3.7': 'gemini-3.1-flash',
  'gemini-2.5': 'gemini-2.5-pro',
  'gemini-2-pro': 'gemini-2.0-pro',
  'gemini-2-flash': 'gemini-2.0-flash',
  'gemini-2.0': 'gemini-2.0-flash',
  'gemini-2': 'gemini-2.0-flash',
  'gemini-1.5-pro-latest': 'gemini-1.5-pro',
  'gemini-1.5-flash-latest': 'gemini-1.5-flash',
  'gemini-2.0-flash-exp': 'gemini-2.0-flash',
  'gemini-2.0-flash-thinking-exp': 'gemini-2.0-flash',
  'gemini-2.5-flash-thinking': 'gemini-2.5-flash',
  'gemini-thinking': 'gemini-2.5-flash'
}

export function normalizeModelForPricing(model: string | null): string | null {
  if (!model) {
    return null
  }
  let lower = model
    .toLowerCase()
    .trim()
    .replace(/^(google|models|google-antigravity)[/:]/, '')
    .replace(/^@google\//, '')

  // Strip trailing date or version codes like -20241022, -001, -002, -preview-02-05
  lower = lower.replace(/-(?:\d{8}|\d{4}|\d{3})$/, '')

  const alias = MODEL_ALIASES[lower]
  if (alias) {
    return alias
  }

  if (MODEL_PRICING[lower]) {
    return lower
  }

  // Why: require a Gemini prefix or substring so unrelated model IDs (e.g. custom 'pro' or 'opus') are rejected.
  if (!lower.startsWith('gemini') && !lower.includes('gemini')) {
    return null
  }

  // Handle flash-lite models
  if (lower.includes('flash-lite')) {
    if (lower.includes('3.1') || lower.includes('3-1')) {
      return 'gemini-3.1-flash-lite'
    }
    if (lower.includes('2.0') || lower.includes('2-0')) {
      return 'gemini-2.0-flash-lite'
    }
    return 'gemini-2.5-flash-lite'
  }

  // Handle flash models (including thinking)
  if (lower.includes('flash')) {
    if (lower.includes('3.1') || lower.includes('3-1')) {
      return 'gemini-3.1-flash'
    }
    if (lower.includes('3.0') || lower.includes('3-0') || lower.includes('3-flash')) {
      return 'gemini-3.0-flash'
    }
    if (lower.includes('2.0') || lower.includes('2-0')) {
      return 'gemini-2.0-flash'
    }
    if (lower.includes('1.5') || lower.includes('1-5')) {
      return 'gemini-1.5-flash'
    }
    return 'gemini-2.5-flash'
  }

  // Handle pro models
  if (lower.includes('pro')) {
    if (lower.includes('3.1') || lower.includes('3-1')) {
      return 'gemini-3.1-pro'
    }
    if (lower.includes('3.0') || lower.includes('3-0') || lower.includes('3-pro')) {
      return 'gemini-3.0-pro'
    }
    if (lower.includes('2.0') || lower.includes('2-0')) {
      return 'gemini-2.0-pro'
    }
    if (lower.includes('1.5') || lower.includes('1-5')) {
      return 'gemini-1.5-pro'
    }
    return 'gemini-2.5-pro'
  }

  if (lower.includes('ultra')) {
    return 'gemini-ultra'
  }

  if (lower.includes('exp') || lower.includes('experimental')) {
    return 'gemini-exp'
  }

  return null
}
