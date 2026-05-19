import type {
  AnthropicCompatPreset,
  ClaudeAuthCredentials,
  ClaudeModelMapping
} from '../../shared/types'

const ANTHROPIC_NATIVE_DEFAULTS: Required<ClaudeModelMapping> = {
  opus: 'claude-opus-4-7',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5-20251001'
}

const COMPAT_DEFAULTS: Record<AnthropicCompatPreset, ClaudeModelMapping> = {
  zai: { opus: 'glm-5.1', sonnet: 'glm-5.1', haiku: 'glm-4.5-air' },
  kimi: { opus: 'kimi-k2.6', sonnet: 'kimi-k2.6', haiku: 'kimi-k2.6' },
  minimax: { opus: 'MiniMax-M2.7', sonnet: 'MiniMax-M2.7', haiku: 'MiniMax-M2.7-highspeed' },
  custom: {}
}

const COMPAT_BASE_URLS: Record<AnthropicCompatPreset, string | null> = {
  zai: 'https://api.z.ai/api/anthropic',
  kimi: 'https://api.moonshot.ai/anthropic',
  minimax: 'https://api.minimax.io/anthropic',
  custom: null
}

export function getDefaultModelMapping(creds: ClaudeAuthCredentials): ClaudeModelMapping {
  if (
    creds.authMethod === 'anthropic-api-key' ||
    creds.authMethod === 'subscription-oauth' ||
    creds.authMethod === 'azure-foundry'
  ) {
    return { ...ANTHROPIC_NATIVE_DEFAULTS }
  }
  if (creds.authMethod === 'anthropic-compat') {
    return { ...COMPAT_DEFAULTS[creds.preset] }
  }
  return {}
}

export function getDefaultBaseUrl(preset: AnthropicCompatPreset): string | null {
  return COMPAT_BASE_URLS[preset]
}
