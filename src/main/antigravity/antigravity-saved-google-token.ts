// The Google sign-in Orca's managed Antigravity server saved, read from disk without starting the
// server or touching its sign-in state.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AntigravityChatAuthConfig } from '../../shared/agent-accounts/antigravity/antigravity-chat-auth-config'
import { ANTIGRAVITY_ACP_HOME } from '../../shared/agent-session/lifecycle/provider-handles/antigravity-session-origin'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'
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
