// Where new Antigravity chats run on this host. agy runs every chat; the saved sign-in method alone
// picks its home, so a chat start, its model list and Install never disagree and never wait on a
// check of agy. agy's sign-in is checked only to say so.

import { isAbsolute } from 'node:path'
import type { AcpHostBackendInput } from '../acp/launch/acp-launch-contract'
import { AntigravityChatAuthConfigSchema } from '../../shared/agent-accounts/antigravity/antigravity-chat-auth-config'
import { assertAntigravityChatAuthPublished } from './antigravity-chat-auth-publication'
import { checkAntigravityHostAcp, checkAntigravityHostAcpCompatible } from './antigravity-host-acp'
import { agyCredentialPresence } from './agy-credential-presence'
import { antigravityChatSignIn } from './antigravity-chat-account'

export type AntigravityAgySignIn = 'signedIn' | 'signedOut' | 'unknown' | 'notInstalled'

/** Whether new chats run on agy's own home and login: only the Google account method. Every other
 *  choice, a malformed one, or one still being saved runs on Orca's home, whose settings.json
 *  names the method agy then uses. */
function savedChatAuthMethod(value: unknown): string | null {
  try {
    assertAntigravityChatAuthPublished(value)
  } catch {
    return null
  }
  const parsed = AntigravityChatAuthConfigSchema.safeParse(
    value === undefined ? { method: 'oauth-personal' } : value
  )
  return parsed.success ? parsed.data.method : null
}

export const savedChatAuthIsPersonal = (value: unknown): boolean =>
  savedChatAuthMethod(value) === 'oauth-personal'

/** Google sign-in, personal or Enterprise: chats use agy's own login, wherever they run. */
export function savedChatAuthUsesAgyLogin(value: unknown): boolean {
  const method = savedChatAuthMethod(value)
  return method === 'oauth-personal' || method === 'oauth-business'
}

let lastAgySignIn: AntigravityAgySignIn | null = null
let agyLoginGeneration = 0

/** agy's login changed (a sign-in, an account switch): checks already under way are stale. */
export function noteAgyLoginChanged(): void {
  agyLoginGeneration += 1
}
let lastRunsInOrcaHome = false

/** Whether the latest new-chat answer runs chats in a home Orca owns, which loads skill folders but
 *  not `~/.gemini`'s plugins; false before any. */
export function lastAntigravityChatRunsInOrcaHome(): boolean {
  return lastRunsInOrcaHome
}

/** Where new chats run on this host for the saved method: agy's own home (true) or Orca's. */
export function antigravityChatRunsOnAgyHome(savedAuth: unknown): boolean {
  const personal = savedChatAuthIsPersonal(savedAuth)
  lastRunsInOrcaHome = !personal
  return personal
}
let agyOrcaHomeRevision = 0
const agyOrcaHomeListeners = new Set<() => void>()

/** Changes whenever a saved key changes, which decides whether key chats and their listings run. */
export function antigravityAgyOrcaHomeRevision(): number {
  return agyOrcaHomeRevision
}

export function onAntigravityAgyOrcaHomeChanged(listener: () => void): () => void {
  agyOrcaHomeListeners.add(listener)
  return () => agyOrcaHomeListeners.delete(listener)
}

/** A saved Gemini API key was added or removed. */
export function onAntigravityChatApiKeyChanged(): void {
  agyOrcaHomeRevision += 1
  agyOrcaHomeListeners.forEach((listener) => listener())
}

/** Whether agy on its own home is definitely signed out, as the latest check (a chat start, an
 *  install surface, Accounts) found; null before any. Reads only that answer. */
export function lastAntigravityAgySignedOut(): boolean | null {
  return lastAgySignIn === null ? null : lastAgySignIn === 'signedOut'
}

/** agy's own sign-in for Google-account chats. Without a login to find, only whether agy can serve
 *  chats is asked, once per binary: on a locked-keyring host a session request raises the keyring
 *  prompt, which agy itself asks for when a chat starts. */
export async function antigravityAgySignIn(
  input: AcpHostBackendInput
): Promise<AntigravityAgySignIn> {
  const generation = agyLoginGeneration
  const answer = await readAgySignIn(input)
  // A login since this check began answers for itself; this answer describes the old one.
  if (generation !== agyLoginGeneration) {
    return answer
  }
  lastAgySignIn = answer
  // Every surface showing agy's sign-in reads it from here, and re-reads when it changes.
  const auth = answer === 'signedIn' || answer === 'signedOut' ? answer : null
  const shown = antigravityChatSignIn.get().value
  if (auth && shown.auth !== auth) {
    antigravityChatSignIn.set({ ...shown, auth })
  }
  return answer
}

async function readAgySignIn(input: AcpHostBackendInput): Promise<AntigravityAgySignIn> {
  const { command, env, envToDelete, homePath } = input
  if (!isAbsolute(command)) {
    return 'notInstalled'
  }
  const presence = await agyCredentialPresence(homePath)
  if (presence !== 'present') {
    const compatible = await checkAntigravityHostAcpCompatible(command, env, envToDelete, {
      start: input.startsProgram
    })
    return compatible === 'ready' && presence === 'absent' ? 'signedOut' : 'unknown'
  }
  const answer = await checkAntigravityHostAcp(command, env, envToDelete)
  return answer === 'ready' ? 'signedIn' : answer === 'signedOut' ? 'signedOut' : 'unknown'
}
