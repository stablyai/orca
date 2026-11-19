// The Google sign-in Orca's managed Antigravity server saved, read without starting the server.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AntigravityChatAuthConfig } from '../../shared/agent-accounts/antigravity/antigravity-chat-auth-config'
import { ANTIGRAVITY_ACP_HOME } from '../../shared/agent-session/lifecycle/provider-handles/antigravity-session-origin'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'
import { antigravityChatSignIn } from './antigravity-chat-account'
import { ANTIGRAVITY_CHAT_HOME_FOLDER } from './antigravity-chat-home'

/** The server keeps each Google sign-in in its own file; key and ADC methods save none. */
export const ANTIGRAVITY_OAUTH_TOKEN_FILES: Partial<
  Record<AntigravityChatAuthConfig['method'], string>
> = {
  'oauth-personal': 'acp_token.json',
  'oauth-business': 'acp_business_token.json'
}

const managedHome = (): string => join(getProfileUserDataPath(), ANTIGRAVITY_CHAT_HOME_FOLDER)

/** Whether the method's token file holds a JSON object; never reads past that. */
export async function hasSavedAntigravityGoogleSignIn(
  method: AntigravityChatAuthConfig['method'],
  home: string = managedHome()
): Promise<boolean> {
  const file = ANTIGRAVITY_OAUTH_TOKEN_FILES[method]
  if (!file) {
    return false
  }
  const text = await readFile(join(home, ANTIGRAVITY_ACP_HOME, file), 'utf8').catch(() => null)
  if (!text) {
    return false
  }
  try {
    const token: unknown = JSON.parse(text)
    return typeof token === 'object' && token !== null && !Array.isArray(token)
  } catch {
    return false
  }
}

let seeding: Promise<void> | null = null

/** Until a chat's handshake answers, a saved Google token stands for signed in, so a restart
 *  doesn't ask to sign in again. Only `unknown` is seeded; the server's answer always wins. */
export function seedAntigravityChatAuth(
  readMethod: () => AntigravityChatAuthConfig['method'] | null,
  home?: string
): Promise<void> {
  const { value, revision } = antigravityChatSignIn.get()
  // A running flow is about to answer, and may be replacing this very token.
  if (value.auth !== 'unknown' || value.flow !== null || seeding) {
    return seeding ?? Promise.resolve()
  }
  let method: AntigravityChatAuthConfig['method'] | null
  try {
    method = readMethod()
  } catch {
    return Promise.resolve()
  }
  if (!method || !ANTIGRAVITY_OAUTH_TOKEN_FILES[method]) {
    return Promise.resolve()
  }
  const check = hasSavedAntigravityGoogleSignIn(method, home)
    .then((saved) => {
      const now = antigravityChatSignIn.get()
      // Anything that happened meanwhile (an answer, a flow, a method change) is newer than the file.
      if (saved && now.revision === revision && now.value.auth === 'unknown' && !now.value.flow) {
        antigravityChatSignIn.set({ ...now.value, auth: 'signedIn' })
      }
    })
    .finally(() => {
      seeding = null
    })
  seeding = check
  return check
}
