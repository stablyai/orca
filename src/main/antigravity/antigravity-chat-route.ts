// Where new Antigravity chats run on this host, and how agy's own sign-in stands there.

import { isAbsolute } from 'node:path'
import type { AcpHostBackendInput } from '../acp/launch/acp-launch-contract'
import { AntigravityChatAuthConfigSchema } from '../../shared/agent-accounts/antigravity/antigravity-chat-auth-config'
import { assertAntigravityChatAuthPublished } from './antigravity-chat-auth-publication'
import { checkAntigravityHostAcp, checkAntigravityHostAcpCompatible } from './antigravity-host-acp'
import { agyCredentialPresence } from './agy-credential-presence'

/** A Gemini API key or gcloud saved in Orca runs new chats on Orca's chat home, which reads them;
 *  a malformed choice, or one still being saved, does too rather than guess agy's login. */
export function antigravityChatUsesOrcaHome(value: unknown): boolean {
  try {
    assertAntigravityChatAuthPublished(value)
  } catch {
    return true
  }
  if (value === undefined) {
    return false
  }
  const parsed = AntigravityChatAuthConfigSchema.safeParse(value)
  return (
    !parsed.success ||
    (parsed.data.method !== 'oauth-personal' && parsed.data.method !== 'oauth-business')
  )
}

/** agy's own sign-in as last checked, for chats on agy's home: `unknown` when not asked or not
 *  answered, `notInstalled` before any agy resolves here. */
export type AntigravityAgySignIn = 'signedIn' | 'signedOut' | 'unknown' | 'notInstalled'

let lastAgySignIn: AntigravityAgySignIn | null = null

/** Whether agy is definitely signed out, as the latest answer here (a chat start on agy's home,
 *  Accounts) found; null before any. Reads only that answer. */
export function lastAntigravityAgySignedOut(): boolean | null {
  return lastAgySignIn === null ? null : lastAgySignIn === 'signedOut'
}

export async function antigravityAgySignIn(
  input: AcpHostBackendInput
): Promise<AntigravityAgySignIn> {
  lastAgySignIn = await askAgySignIn(input)
  return lastAgySignIn
}

async function askAgySignIn(input: AcpHostBackendInput): Promise<AntigravityAgySignIn> {
  const { command, env, envToDelete, homePath } = input
  if (!isAbsolute(command)) {
    return 'notInstalled'
  }
  const presence = await agyCredentialPresence(homePath)
  // Without a login to find, only whether agy can serve chats is asked: a session request behind
  // a locked keyring raises its unlock prompt, and agy asks for the keyring when a chat starts.
  if (presence !== 'present') {
    const compatible = await checkAntigravityHostAcpCompatible(command, env, envToDelete, {
      start: input.startsProgram
    })
    return compatible === 'ready' && presence === 'absent' ? 'signedOut' : 'unknown'
  }
  const answer = await checkAntigravityHostAcp(command, env, envToDelete)
  return answer === 'ready' ? 'signedIn' : answer === 'signedOut' ? 'signedOut' : 'unknown'
}
