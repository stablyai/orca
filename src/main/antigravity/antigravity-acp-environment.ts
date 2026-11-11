import { ANTIGRAVITY_BROWSER_COMMAND } from './antigravity-browser-helper'

// Isolate sign-in files, capture browser links and flush Python output after scrubbing inherited auth.
export const ANTIGRAVITY_ACP_ENV = {
  AGY_ACP_FORCE_FILE_STORAGE: '1',
  BROWSER: ANTIGRAVITY_BROWSER_COMMAND,
  PYTHONUNBUFFERED: '1',
  ELECTRON_RUN_AS_NODE: '1'
}

/** Remove inherited authentication and harness overrides. */
export function scrubAntigravityAcpEnvironment(
  env: Record<string, string>,
  inherited: NodeJS.ProcessEnv
): string[] {
  const removed = [...new Set([...Object.keys(env), ...Object.keys(inherited)])].filter((key) => {
    const normalized = process.platform === 'win32' ? key.toUpperCase() : key
    const shadowsConfiguredValue =
      process.platform === 'win32' &&
      Object.hasOwn(ANTIGRAVITY_ACP_ENV, normalized) &&
      key !== normalized
    return (
      shadowsConfiguredValue ||
      (!Object.hasOwn(ANTIGRAVITY_ACP_ENV, normalized) &&
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
