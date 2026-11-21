// A Gemini API key chat that starts without a key leaves the server to fall back to a Google login
// saved in the same chat home, billing another account than Settings shows. Only that case is
// refused: without a saved Google login the server's own answer stands, as before. gcloud chats
// are never refused here, since ADC's lookup (CLOUDSDK_CONFIG and home folders, Windows APPDATA,
// metadata servers) can't be mirrored reliably; the server answers for them, as before.

import type { AntigravityChatAuthConfig } from '../../shared/agent-accounts/antigravity/antigravity-chat-auth-config'
import { AgentSessionAcquisitionRefusal } from '../native-chat/agent-session-wire/providers/structured-agent-session-adapter-errors'
import {
  providerDiagnostic,
  withProviderDiagnostic
} from '../../shared/agent-session/failures/agent-session-failure'
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

async function hasSavedGoogleLogin(home: string): Promise<boolean> {
  const saved = await Promise.all(
    (['oauth-personal', 'oauth-business'] as const).map((method) =>
      hasSavedAntigravityGoogleSignIn(method, home)
    )
  )
  return saved.some(Boolean)
}

/** Refuses a chat start (never a listing) on the Gemini API key method with no key, saved or in
 *  the environment the server gets (it reads no `.env`, checked on 1.5.0 and 1.5.2), while a
 *  Google login is saved in its chat home; the chat says why and its Sign in opens Settings. */
export async function assertAntigravityChatCredential(
  auth: AntigravityChatAuthConfig,
  env: Readonly<Record<string, string>>,
  home: string
): Promise<void> {
  if (
    auth.method !== 'gemini-api-key' ||
    envValue(env, 'GEMINI_API_KEY')?.trim() ||
    !(await hasSavedGoogleLogin(home))
  ) {
    return
  }
  throw missingCredential(
    (await hasAntigravityChatApiKey())
      ? "The Gemini API key saved for Antigravity can't be read on this computer. Save it again under Settings → Accounts → Antigravity."
      : "No Gemini API key is saved for Antigravity, and GEMINI_API_KEY isn't set. Add a key under Settings → Accounts → Antigravity."
  )
}
