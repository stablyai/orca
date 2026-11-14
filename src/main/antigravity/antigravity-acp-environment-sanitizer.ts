const CONFIGURED_ANTIGRAVITY_ACP_ENVIRONMENT_KEYS = new Set([
  'AGY_ACP_FORCE_FILE_STORAGE',
  'BROWSER',
  'PYTHONUNBUFFERED',
  'ELECTRON_RUN_AS_NODE'
])

/** Remove inherited authentication, harness and stale Electron Crashpad overrides. */
export function scrubAntigravityAcpEnvironment(
  env: Record<string, string>,
  inherited: NodeJS.ProcessEnv
): string[] {
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
