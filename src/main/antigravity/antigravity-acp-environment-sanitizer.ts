import type { AntigravityChatAuthConfig } from '../../shared/agent-accounts/antigravity/antigravity-chat-auth-config'

const CONFIGURED_ANTIGRAVITY_ACP_ENVIRONMENT_KEYS = new Set([
  'AGY_ACP_FORCE_FILE_STORAGE',
  'BROWSER',
  'PYTHONUNBUFFERED',
  'ELECTRON_RUN_AS_NODE'
])

// The credentials each saved account type reads from the launch environment.
const AUTH_ENVIRONMENT_KEYS: Partial<
  Record<AntigravityChatAuthConfig['method'], ReadonlySet<string>>
> = {
  'gemini-api-key': new Set(['GEMINI_API_KEY', 'GOOGLE_GEMINI_BASE_URL']),
  'agent-platform': new Set([
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GOOGLE_CLOUD_PROJECT',
    'GOOGLE_CLOUD_LOCATION',
    'GOOGLE_CLOUD_QUOTA_PROJECT'
  ])
}

/** Remove inherited authentication, harness and stale Electron Crashpad overrides, keeping only
 *  the credentials the chat's saved account type reads. */
export function scrubAntigravityAcpEnvironment(
  env: Record<string, string | undefined>,
  inherited: NodeJS.ProcessEnv,
  chatAuth?: AntigravityChatAuthConfig
): string[] {
  const kept = chatAuth ? AUTH_ENVIRONMENT_KEYS[chatAuth.method] : undefined
  const removed = [...new Set([...Object.keys(env), ...Object.keys(inherited)])].filter((key) => {
    const normalized = process.platform === 'win32' ? key.toUpperCase() : key
    const shadowsConfiguredValue =
      process.platform === 'win32' &&
      CONFIGURED_ANTIGRAVITY_ACP_ENVIRONMENT_KEYS.has(normalized) &&
      key !== normalized
    return (
      shadowsConfiguredValue ||
      normalized.toUpperCase() === 'CHROME_CRASHPAD_PIPE_NAME' ||
      (!CONFIGURED_ANTIGRAVITY_ACP_ENVIRONMENT_KEYS.has(normalized) &&
        !kept?.has(normalized) &&
        (normalized === 'GEMINI_API_KEY' ||
          normalized === 'ANTIGRAVITY_HARNESS_PATH' ||
          normalized === 'GCLOUD_PROJECT' ||
          normalized === 'CLOUDSDK_CORE_PROJECT' ||
          normalized.startsWith('GOOGLE_') ||
          normalized.startsWith('AGY_ACP_')))
    )
  })
  for (const key of removed) {
    delete env[key]
  }
  return removed
}
