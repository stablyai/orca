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

// Why: Bedrock model ids are stored unprefixed in the registry. The geographic
// inference-profile prefix (e.g. `us.`) is applied by the Bedrock handler at
// materialize time, because the prefix is region-derived rather than a model
// identity. Hoisting only the bare ids keeps a single source of truth for
// model defaults while leaving prefix logic with the handler that owns region.
const BEDROCK_DEFAULTS: Required<ClaudeModelMapping> = {
  opus: 'anthropic.claude-opus-4-7',
  sonnet: 'anthropic.claude-sonnet-4-6',
  haiku: 'anthropic.claude-haiku-4-5-20251001-v1:0'
}

// Why: Vertex model ids use Google's `@`-versioned suffix (vs. Bedrock's
// `-v1:0`), but no per-region prefix — the region is a separate env var.
const VERTEX_DEFAULTS: Required<ClaudeModelMapping> = {
  opus: 'claude-opus-4-7',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5@20251001'
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
  if (creds.authMethod === 'aws-bedrock') {
    return { ...BEDROCK_DEFAULTS }
  }
  if (creds.authMethod === 'google-vertex') {
    return { ...VERTEX_DEFAULTS }
  }
  return {}
}

export function getDefaultBaseUrl(preset: AnthropicCompatPreset): string | null {
  return COMPAT_BASE_URLS[preset]
}

export function getBedrockDefaults(): Required<ClaudeModelMapping> {
  return { ...BEDROCK_DEFAULTS }
}

export function getVertexDefaults(): Required<ClaudeModelMapping> {
  return { ...VERTEX_DEFAULTS }
}
