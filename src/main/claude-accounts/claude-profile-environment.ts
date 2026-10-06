// A bound OAuth account must not be redirected to an inherited cloud provider.
export const CLAUDE_PROFILE_PROVIDER_ENV_VARS = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'CLAUDE_SECURESTORAGE_CONFIG_DIR',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_HOST_AUTH_ENV_VAR',
  'CLAUDE_CODE_HOST_CREDS_FILE',
  'CLAUDE_CODE_CUSTOM_OAUTH_URL'
] as const

export function assertClaudeProfileEnvironment(env?: Record<string, string>): void {
  for (const [key, value] of Object.entries(env ?? {})) {
    if (
      key.toUpperCase() === 'CLAUDE_CONFIG_DIR' ||
      (value && CLAUDE_PROFILE_PROVIDER_ENV_VARS.some((name) => name === key.toUpperCase()))
    ) {
      throw new Error(`Remove the ${key} override before launching a Claude profile.`)
    }
  }
}

export function stripClaudeProfileProviderEnvironment(env: Record<string, string>): void {
  for (const key of Object.keys(env)) {
    if (CLAUDE_PROFILE_PROVIDER_ENV_VARS.some((name) => name === key.toUpperCase())) {
      delete env[key]
    }
  }
}
