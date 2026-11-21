// A key or gcloud chat that starts without its credential leaves the server to fall back to a
// Google login saved in the same chat home, billing another account than Settings shows. Only that
// case is refused: without a saved Google login the server's own answer stands, as before.

import { readFile, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { AntigravityChatAuthConfig } from '../../shared/agent-accounts/antigravity/antigravity-chat-auth-config'
import { AgentSessionAcquisitionRefusal } from '../native-chat/agent-session-wire/providers/structured-agent-session-adapter-errors'
import {
  providerDiagnostic,
  withProviderDiagnostic
} from '../../shared/agent-session/failures/agent-session-failure'
import { agentPlatformCredentialsFile } from './antigravity-agent-platform-project'
import { hasAntigravityChatApiKey } from './antigravity-chat-api-key-store'
import { hasSavedAntigravityGoogleSignIn } from './antigravity-saved-google-token'

function missingCredential(text: string): Error {
  const refusal = new AgentSessionAcquisitionRefusal(text, 'notSignedIn', 'managed')
  const detail = providerDiagnostic(text, 'person')
  return detail ? withProviderDiagnostic(refusal, detail) : refusal
}

/** `name` as the child will see it; Windows names are case-insensitive. */
export function envValue(
  env: Readonly<Record<string, string>>,
  name: string,
  platform: NodeJS.Platform = process.platform
): string | undefined {
  if (platform !== 'win32') {
    return env[name]
  }
  const upper = name.toUpperCase()
  return Object.entries(env).find(([key]) => key.toUpperCase() === upper)?.[1]
}

let onGoogleCloud: Promise<boolean> | null = null

/** Whether ADC can come from the metadata server (GCE, GKE, Cloud Run, Workstations), as Google's
 *  own lookup falls back to after the well-known file; read once per host process. */
export function plausibleMetadataCredentials(
  env: Readonly<Record<string, string>>,
  readProductName: () => Promise<string> = () => readFile('/sys/class/dmi/id/product_name', 'utf8')
): Promise<boolean> {
  if (envValue(env, 'GCE_METADATA_HOST')) {
    return Promise.resolve(true)
  }
  onGoogleCloud ??= readProductName().then(
    (name) => name.includes('Google'),
    () => false
  )
  return onGoogleCloud
}

async function adcMayResolve(env: Readonly<Record<string, string>>): Promise<boolean> {
  const file = envValue(env, 'GOOGLE_APPLICATION_CREDENTIALS') || agentPlatformCredentialsFile(env)
  // A relative path resolves against the server's working folder, which isn't known here.
  if (!isAbsolute(file) || (await stat(file).catch(() => null))?.isFile()) {
    return true
  }
  return plausibleMetadataCredentials(env)
}

async function hasSavedGoogleLogin(home: string): Promise<boolean> {
  const saved = await Promise.all(
    (['oauth-personal', 'oauth-business'] as const).map((method) =>
      hasSavedAntigravityGoogleSignIn(method, home)
    )
  )
  return saved.some(Boolean)
}

/** Refuses a chat start (never a listing) whose key or gcloud credential is missing while a Google
 *  login is saved in its chat home; the chat says why and its Sign in opens Settings. */
export async function assertAntigravityChatCredential(
  auth: AntigravityChatAuthConfig,
  env: Readonly<Record<string, string>>,
  home: string
): Promise<void> {
  if (auth.method === 'gemini-api-key') {
    if (envValue(env, 'GEMINI_API_KEY')?.trim() || !(await hasSavedGoogleLogin(home))) {
      return
    }
    throw missingCredential(
      (await hasAntigravityChatApiKey())
        ? "The Gemini API key saved for Antigravity can't be read on this computer. Save it again under Settings → Accounts → Antigravity."
        : "No Gemini API key is saved for Antigravity, and GEMINI_API_KEY isn't set. Add a key under Settings → Accounts → Antigravity."
    )
  }
  if (auth.method !== 'agent-platform') {
    return
  }
  if ((await adcMayResolve(env)) || !(await hasSavedGoogleLogin(home))) {
    return
  }
  throw missingCredential(
    'No gcloud login was found. Run `gcloud auth application-default login`, or choose another sign-in under Settings → Accounts → Antigravity.'
  )
}

/** Forgets the metadata-server answer; tests only. */
export function forgetPlausibleMetadataCredentials(): void {
  onGoogleCloud = null
}
