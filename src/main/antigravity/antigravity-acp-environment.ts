// The environment every Antigravity ACP server Orca starts runs under: a chat's, and the one
// Install starts to check its download.

import { ANTIGRAVITY_BROWSER_COMMAND } from './antigravity-browser-helper'

// Applied after the scrub: the server's sign-in stays in its own folder's file rather than the
// keychain slot every server on the machine shares, its browser is Orca's helper that prints the
// sign-in link, and its Python output is not held back in a buffer.
export const ANTIGRAVITY_ACP_ENV = {
  AGY_ACP_FORCE_FILE_STORAGE: '1',
  BROWSER: ANTIGRAVITY_BROWSER_COMMAND,
  PYTHONUNBUFFERED: '1'
}

/** Drops what would sign the server in some other way or run another harness than its own. */
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
