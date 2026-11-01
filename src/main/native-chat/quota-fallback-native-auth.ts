export type NativeQuotaApiCredential = {
  route: 'claude-api' | 'openai-api'
  apiKey: string
  maxDebitUsd: number
}

export function quotaApiEnvironment(
  inherited: Readonly<Record<string, string>>,
  credential: NativeQuotaApiCredential
): { env: Record<string, string>; removed: string[] } {
  if (
    !credential.apiKey ||
    /[\r\n]/.test(credential.apiKey) ||
    !Number.isFinite(credential.maxDebitUsd) ||
    credential.maxDebitUsd <= 0
  ) {
    throw new Error('Invalid quota API credential')
  }
  const env = { ...inherited }
  const removed: string[] = []
  const pattern =
    credential.route === 'claude-api'
      ? /^(ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_USE_|CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST)/i
      : /^(OPENAI_API_KEY|OPENAI_BASE_URL|CODEX_API_KEY|ORCA_QUOTA_API_KEY)$/i
  for (const name of Object.keys(env)) {
    if (pattern.test(name)) {
      delete env[name]
      removed.push(name)
    }
  }
  const kept = new Set<string>()
  if (credential.route === 'claude-api') {
    env.ANTHROPIC_API_KEY = credential.apiKey
    env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'
    kept.add('ANTHROPIC_API_KEY')
    kept.add('CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST')
  } else {
    env.ORCA_QUOTA_API_KEY = credential.apiKey
    kept.add('ORCA_QUOTA_API_KEY')
  }
  return { env, removed: removed.filter((key) => !kept.has(key)) }
}

export const QUOTA_CODEX_PROVIDER = 'orca_quota_api'
export function quotaCodexProviderArgs(): string[] {
  return [
    '-c',
    `model_provider="${QUOTA_CODEX_PROVIDER}"`,
    '-c',
    `model_providers.${QUOTA_CODEX_PROVIDER}.name="OpenAI API credit"`,
    '-c',
    `model_providers.${QUOTA_CODEX_PROVIDER}.base_url="https://api.openai.com/v1"`,
    '-c',
    `model_providers.${QUOTA_CODEX_PROVIDER}.wire_api="responses"`,
    '-c',
    `model_providers.${QUOTA_CODEX_PROVIDER}.env_key="ORCA_QUOTA_API_KEY"`,
    '-c',
    `model_providers.${QUOTA_CODEX_PROVIDER}.requires_openai_auth=false`
  ]
}
