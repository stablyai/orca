// The Google sign-in Orca's managed Antigravity server saved, read without starting the server.

import type { AntigravityChatAuthConfig } from '../../shared/agent-accounts/antigravity/antigravity-chat-auth-config'
import { antigravityChatSignIn } from './antigravity-chat-account'
import {
  ANTIGRAVITY_OAUTH_TOKEN_FILES,
  hasSavedAntigravityGoogleSignIn
} from './antigravity-saved-google-token'

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
