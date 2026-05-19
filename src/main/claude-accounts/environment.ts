import type { MaterializedEnvPatch } from './providers/types'

export const CLAUDE_AUTH_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK'
] as const

// Full provider-env allowlist. Replaces the denylist + exceptions model in
// applyClaudeEnvPatch.stripAuthEnv — stripping every known provider key before
// re-emitting from the materialized patch avoids leaks when new keys are added
// upstream (autoplan E1).
export const PROVIDER_ENV_KEYS = [
  // Anthropic-native
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  // Bedrock (placeholder for P3, strip preemptively)
  'AWS_BEARER_TOKEN_BEDROCK',
  'CLAUDE_CODE_USE_BEDROCK',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  // Vertex (placeholder for P3)
  'CLAUDE_CODE_USE_VERTEX',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'CLOUD_ML_REGION',
  // Foundry (placeholder for P2)
  'CLAUDE_CODE_USE_FOUNDRY',
  'ANTHROPIC_FOUNDRY_RESOURCE',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'ANTHROPIC_FOUNDRY_API_KEY',
  // Host gate
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST'
] as const

export type ClaudeEnvPatch = {
  CLAUDE_CONFIG_DIR?: string
  ANTHROPIC_CUSTOM_HEADERS?: string
}

export function applyClaudeEnvPatch(
  baseEnv: Record<string, string>,
  patch: ClaudeEnvPatch,
  options?: { stripAuthEnv?: boolean }
): Record<string, string> {
  if (options?.stripAuthEnv) {
    for (const key of CLAUDE_AUTH_ENV_VARS) {
      delete baseEnv[key]
    }
    if (isAuthLikeCustomHeaders(baseEnv.ANTHROPIC_CUSTOM_HEADERS)) {
      delete baseEnv.ANTHROPIC_CUSTOM_HEADERS
    }
  }

  if (patch.CLAUDE_CONFIG_DIR) {
    baseEnv.CLAUDE_CONFIG_DIR = patch.CLAUDE_CONFIG_DIR
  }
  if (patch.ANTHROPIC_CUSTOM_HEADERS !== undefined) {
    baseEnv.ANTHROPIC_CUSTOM_HEADERS = patch.ANTHROPIC_CUSTOM_HEADERS
  }

  return baseEnv
}

export function hasClaudeAuthEnvConflict(env: Record<string, string> | undefined): boolean {
  if (!env) {
    return false
  }
  return (
    CLAUDE_AUTH_ENV_VARS.some((key) => Boolean(env[key])) ||
    isAuthLikeCustomHeaders(env.ANTHROPIC_CUSTOM_HEADERS)
  )
}

function isAuthLikeCustomHeaders(value: string | undefined): boolean {
  if (!value) {
    return false
  }
  return /authorization|x-api-key|api-key|bearer/i.test(value)
}

// Allowlist + full-replace model. Strip every known provider key, then re-emit
// from the materialization patch. Safer than the legacy denylist because new
// upstream env vars can't leak across account switches (autoplan E1).
export function applyEnvFromMaterialization(
  baseEnv: Record<string, string>,
  materialization: MaterializedEnvPatch
): Record<string, string> {
  const out: Record<string, string> = { ...baseEnv }

  // Strip every known provider key.
  for (const key of PROVIDER_ENV_KEYS) {
    delete out[key]
  }

  // Strip auth-shaped ANTHROPIC_CUSTOM_HEADERS (leftover bearer/api-key headers).
  if (isAuthLikeCustomHeaders(out.ANTHROPIC_CUSTOM_HEADERS)) {
    delete out.ANTHROPIC_CUSTOM_HEADERS
  }

  // Re-emit from patch.
  for (const [key, value] of Object.entries(materialization.envPatch)) {
    out[key] = value
  }

  if (materialization.configDirPath) {
    out.CLAUDE_CONFIG_DIR = materialization.configDirPath
  }

  return out
}
