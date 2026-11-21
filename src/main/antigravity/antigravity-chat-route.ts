// Where new Antigravity chats run on this host, and so what Install puts here. Select and Install
// read this one answer, so Install never offers a program the chat would not launch.

import { isAbsolute, join } from 'node:path'
import type { AcpHostBackendInput, AcpLaunchSpec } from '../acp/launch/acp-launch-contract'
import { findHostProgram } from '../acp/launch/acp-launch-command'
import { runtimeReleaseMayBePublished } from '../node-runtime/managed-runtime-release'
import { AntigravityChatAuthConfigSchema } from '../../shared/agent-accounts/antigravity/antigravity-chat-auth-config'
import { assertAntigravityChatAuthPublished } from './antigravity-chat-auth-publication'
import { hasSavedAntigravityGoogleSignIn } from './antigravity-saved-google-token'
import { ANTIGRAVITY_CHAT_HOME_FOLDER } from './antigravity-chat-home'
import {
  agyUsesApiKey,
  checkAntigravityHostAcp,
  checkAntigravityHostAcpCompatible
} from './antigravity-host-acp'
import { agyCredentialPresence } from './agy-credential-presence'

export type AntigravityChatRoute = {
  /** New chats run on agy, with its sign-in as last checked (`unknown`: not asked or no answer),
   *  or before it is installed; false runs them on Orca's server. */
  agy: 'signedIn' | 'signedOut' | 'unknown' | 'notInstalled' | false
  /** What Install puts on this host: Orca's server, or Orca's copy of agy. */
  installs: 'server' | 'agy'
}

const ON_SERVER: AntigravityChatRoute = { agy: false, installs: 'server' }

// The host's agy ignores Orca's account type, so any other saved choice, a malformed one, or one
// still being saved keeps new chats on Orca's runtime, whose sign-in honors it.
export function savedChatAuthIsPersonal(value: unknown): boolean {
  try {
    assertAntigravityChatAuthPublished(value)
  } catch {
    return false
  }
  const parsed = AntigravityChatAuthConfigSchema.safeParse(
    value === undefined ? { method: 'oauth-personal' } : value
  )
  return parsed.success && parsed.data.method === 'oauth-personal'
}

/** Whether this host already uses Orca's server: its release (or an unreadable folder), a copy on
 *  PATH, or a Google sign-in it saved, which outlives removing the release. */
async function usesOrcaServer(input: AcpHostBackendInput, server: AcpLaunchSpec) {
  const root = server.managedRuntime?.root(input.stateDirectory)
  if (root && (await runtimeReleaseMayBePublished(root))) {
    return true
  }
  const onPath = await findHostProgram(
    server.command,
    input.env,
    server.installDirectories({ env: input.env, homePath: input.homePath })
  )
  if (onPath) {
    return true
  }
  const home = join(input.stateDirectory, ANTIGRAVITY_CHAT_HOME_FOLDER)
  const saved = await Promise.all(
    (['oauth-personal', 'oauth-business'] as const).map((method) =>
      hasSavedAntigravityGoogleSignIn(method, home)
    )
  )
  return saved.some(Boolean)
}

/** A signed-in agy takes new chats even where Orca's server is in use (#44613); without the server,
 *  a signed-out agy does too, so its notice says to sign in rather than to install a runtime. */
export async function antigravityChatRoute(
  input: AcpHostBackendInput,
  server: AcpLaunchSpec
): Promise<AntigravityChatRoute> {
  const route = await computeAntigravityChatRoute(input, server)
  lastRoute = route
  return route
}

let lastRoute: AntigravityChatRoute | null = null

/** Whether new chats here run on an agy that is definitely signed out, as the latest route answer
 *  (a chat start, an install surface, Accounts) found; null before any. Reads only that answer. */
export function lastAntigravityAgySignedOut(): boolean | null {
  return lastRoute === null ? null : lastRoute.agy === 'signedOut'
}

async function computeAntigravityChatRoute(
  input: AcpHostBackendInput,
  server: AcpLaunchSpec
): Promise<AntigravityChatRoute> {
  const { command, env, envToDelete, homePath } = input
  // The host launch drops an API-key provider's key, so that agy can't serve chats.
  if (
    !savedChatAuthIsPersonal(input.settings.antigravityChatAuth) ||
    // The person chose Orca's built-in Google sign-in, which runs on Orca's server.
    input.settings.antigravityGoogleSignIn === 'orca' ||
    (await agyUsesApiKey(homePath))
  ) {
    return ON_SERVER
  }
  const agyResolves = isAbsolute(command)
  // Off, Orca's copy of agy takes no new chats (the input never offers it): only the user's own,
  // signed-in agy does, as before Orca installed one. Unlike then, a missing secret-tool lets agy be
  // asked, since gdbus already found the keyring unlocked.
  const managedAgy = input.settings.antigravityManagedAgyEnabled !== false
  // Choosing agy's own sign-in takes Google-account chats to agy even where Orca's server is in use.
  const choseAgy = input.settings.antigravityGoogleSignIn === 'agy'
  if (!managedAgy || (!choseAgy && (await usesOrcaServer(input, server)))) {
    // A signed-in agy still takes new chats; with no login to find, agy isn't asked at all.
    const ready =
      agyResolves &&
      (await agyCredentialPresence(homePath)) === 'present' &&
      (await checkAntigravityHostAcp(command, env, envToDelete)) === 'ready'
    return { agy: ready ? 'signedIn' : false, installs: 'server' }
  }
  // New chats go to agy before it is installed, so Install lands where they already run.
  if (!agyResolves) {
    return { agy: 'notInstalled', installs: 'agy' }
  }
  const presence = await agyCredentialPresence(homePath)
  // Without a login to find, only whether agy can serve chats is asked, once per binary. Seen on a
  // locked-keyring host: `agy acp` opens no D-Bus connection for initialize, but a session request
  // calls Secret Service Unlock and raises its prompt; agy asks for the keyring when a chat starts.
  if (presence !== 'present') {
    const compatible = await checkAntigravityHostAcpCompatible(command, env, envToDelete, {
      start: input.startsProgram
    })
    if (compatible === 'incompatible') {
      return ON_SERVER
    }
    return {
      agy: compatible === 'ready' && presence === 'absent' ? 'signedOut' : 'unknown',
      installs: 'agy'
    }
  }
  const answer = await checkAntigravityHostAcp(command, env, envToDelete)
  // An agy that can't serve chats shadows Orca's copy too, so only the server can help.
  if (answer === 'incompatible') {
    return ON_SERVER
  }
  // A hang or crash shows in the chat's own launch of agy: unlike main, which then fell back to
  // Orca's server, no server is installed here to run instead (where one is, the branch above
  // treats any answer but `ready`, a timeout included, as not ready).
  return {
    agy: answer === 'ready' ? 'signedIn' : answer === 'signedOut' ? 'signedOut' : 'unknown',
    installs: 'agy'
  }
}
