import type { AntigravityChatAuthConfig } from '../../shared/agent-accounts/antigravity/antigravity-chat-auth-config'
import { isChromiumCrashpadPipeNameKey } from '../pty/shell-startup/chromium-crashpad-pipe-env'

// The credentials each saved account type reads from the launch environment.
const AUTH_ENVIRONMENT_KEYS: Partial<
  Record<AntigravityChatAuthConfig['method'], ReadonlySet<string>>
> = {
  'gemini-api-key': new Set(['GEMINI_API_KEY', 'GOOGLE_GEMINI_BASE_URL']),
  'agent-platform': new Set([
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GOOGLE_CLOUD_PROJECT',
    'GOOGLE_CLOUD_LOCATION',
    'GOOGLE_CLOUD_QUOTA_PROJECT',
    'CLOUDSDK_CORE_PROJECT'
  ])
}

/** Remove inherited authentication, agy ACP overrides (such as forcing file storage, which would
 *  hide agy's keyring login) and stale Electron Crashpad overrides, keeping only the credentials the
 *  chat's saved account type reads. */
export function scrubAntigravityAcpEnvironment(
  env: Record<string, string | undefined>,
  inherited: NodeJS.ProcessEnv,
  chatAuth?: AntigravityChatAuthConfig
): string[] {
  const kept = chatAuth ? AUTH_ENVIRONMENT_KEYS[chatAuth.method] : undefined
  const removed = [...new Set([...Object.keys(env), ...Object.keys(inherited)])].filter((key) => {
    const normalized = process.platform === 'win32' ? key.toUpperCase() : key
    return (
      isChromiumCrashpadPipeNameKey(key) ||
      (!kept?.has(normalized) &&
        (normalized === 'GEMINI_API_KEY' ||
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
