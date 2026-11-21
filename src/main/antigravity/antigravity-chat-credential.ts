// A key or gcloud chat that starts without its credential would leave the server to fall back to
// a Google login saved in the same chat home, billing another account than Settings shows.

import { stat } from 'node:fs/promises'
import type { AntigravityChatAuthConfig } from '../../shared/agent-accounts/antigravity/antigravity-chat-auth-config'
import { AgentSessionAcquisitionRefusal } from '../native-chat/agent-session-wire/providers/structured-agent-session-adapter-errors'
import {
  providerDiagnostic,
  withProviderDiagnostic
} from '../../shared/agent-session/failures/agent-session-failure'
import { agentPlatformCredentialsFile } from './antigravity-agent-platform-project'

function missingCredential(text: string): Error {
  const refusal = new AgentSessionAcquisitionRefusal(text, 'notSignedIn', 'managed')
  const detail = providerDiagnostic(text, 'person')
  return detail ? withProviderDiagnostic(refusal, detail) : refusal
}

/** Refuses a Gemini API key chat with no key, and a gcloud chat with no ADC file, before launch;
 *  the chat then says it isn't signed in and why, and its Sign in opens Settings. */
export async function assertAntigravityChatCredential(
  auth: AntigravityChatAuthConfig,
  env: Readonly<Record<string, string>>
): Promise<void> {
  if (auth.method === 'gemini-api-key' && !env.GEMINI_API_KEY?.trim()) {
    throw missingCredential(
      "No Gemini API key is saved for Antigravity, and GEMINI_API_KEY isn't set. Add a key under Settings → Accounts → Antigravity."
    )
  }
  if (auth.method !== 'agent-platform') {
    return
  }
  const adc = await stat(agentPlatformCredentialsFile(env)).catch(() => null)
  if (!adc?.isFile()) {
    throw missingCredential(
      'No gcloud login was found. Run `gcloud auth application-default login`, or choose another sign-in under Settings → Accounts → Antigravity.'
    )
  }
}
