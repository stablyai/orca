import { ANTIGRAVITY_BROWSER_COMMAND } from './antigravity-browser-helper'

// Isolate sign-in files, capture browser links and flush Python output after scrubbing inherited auth.
export const ANTIGRAVITY_ACP_ENV = {
  AGY_ACP_FORCE_FILE_STORAGE: '1',
  BROWSER: ANTIGRAVITY_BROWSER_COMMAND,
  PYTHONUNBUFFERED: '1'
}

/** Remove inherited authentication and harness overrides. */
export function scrubAntigravityAcpEnvironment(
  env: Record<string, string>,
  inherited: NodeJS.ProcessEnv
): string[] {
  const removed = [...new Set([...Object.keys(env), ...Object.keys(inherited)])].filter(
    (key) =>
      !Object.hasOwn(ANTIGRAVITY_ACP_ENV, key) &&
      (key === 'GEMINI_API_KEY' ||
        key === 'ANTIGRAVITY_HARNESS_PATH' ||
        key === 'GCLOUD_PROJECT' ||
        key === 'CLOUDSDK_CORE_PROJECT' ||
        key.startsWith('GOOGLE_') ||
        key.startsWith('AGY_ACP_'))
  )
  for (const key of removed) {
    delete env[key]
  }
  return removed
}
