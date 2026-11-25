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
import { agyServesOrcaHome } from './antigravity-agy-orca-home'
import { agyOrcaHomeKeyPresent } from './antigravity-agy-orca-home-credential'

export type AntigravityChatRoute = {
  /** New chats run on agy, with its sign-in as last checked (`unknown`: not asked or no answer),
   *  or before it is installed; false runs them on Orca's server. */
  agy: 'signedIn' | 'signedOut' | 'unknown' | 'notInstalled' | false
  /** What Install puts on this host: Orca's server, or Orca's copy of agy. */
  installs: 'server' | 'agy'
  /** A Gemini API key chat runs on agy, in a home Orca owns, with Orca's saved key (see
   *  antigravity-agy-orca-home). */
  orcaHome?: true
}

const ON_SERVER: AntigravityChatRoute = { agy: false, installs: 'server' }
// agy is already here, so Install has nothing to add for these chats; reporting the server keeps
// the method and key form for clients that predate this route, which hide it for agy.
const ON_AGY_ORCA_HOME: AntigravityChatRoute = { agy: false, installs: 'server', orcaHome: true }

/** Whether the saved method is a Gemini API key, which agy can run on Orca's home; false for any
 *  other choice, a malformed one or one still being saved. */
function savedKeyMethod(value: unknown): boolean {
  try {
    assertAntigravityChatAuthPublished(value)
  } catch {
    return false
  }
  const parsed = AntigravityChatAuthConfigSchema.safeParse(value)
  return parsed.success && parsed.data.method === 'gemini-api-key'
}

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
let lastOnAgyOrcaHome: boolean | null = null
let agyOrcaHomeRevision = 0
const agyOrcaHomeListeners = new Set<() => void>()

function agyOrcaHomeChanged(): void {
  agyOrcaHomeRevision += 1
  agyOrcaHomeListeners.forEach((listener) => listener())
}

// A key that comes or goes moves key chats; the next answer that sees it makes catalogs and
// availability ask again, so the picker and install strip follow where chats now run.
function noteAgyOrcaHomeRoute(onAgy: boolean): void {
  const flipped = lastOnAgyOrcaHome !== null && lastOnAgyOrcaHome !== onAgy
  lastOnAgyOrcaHome = onAgy
  if (flipped) {
    agyOrcaHomeChanged()
  }
}

/** Changes whenever key chats move between agy and Orca's server, or a saved key changes. */
export function antigravityAgyOrcaHomeRevision(): number {
  return agyOrcaHomeRevision
}

export function onAntigravityAgyOrcaHomeChanged(listener: () => void): () => void {
  agyOrcaHomeListeners.add(listener)
  return () => agyOrcaHomeListeners.delete(listener)
}

/** A saved Gemini API key was added or removed, which can move key chats. */
export function onAntigravityChatApiKeyChanged(): void {
  agyOrcaHomeChanged()
}

/** Whether new chats here run on an agy that is definitely signed out, as the latest route answer
 *  (a chat start, an install surface, Accounts) found; null before any. Reads only that answer. */
export function lastAntigravityAgySignedOut(): boolean | null {
  return lastRoute === null ? null : lastRoute.agy === 'signedOut'
}

/** Whether the latest route answer runs new chats in a home Orca owns (its server, or agy on
 *  Orca's home), which loads skill folders but not `~/.gemini`'s plugins; false before any. */
export function lastAntigravityChatRunsInOrcaHome(): boolean {
  return lastRoute?.agy === false
}

async function computeAntigravityChatRoute(
  input: AcpHostBackendInput,
  server: AcpLaunchSpec
): Promise<AntigravityChatRoute> {
  const { command, env, envToDelete, homePath } = input
  // agy offers newer models than Orca's server, so where it is here (the person's own, or Orca's
  // copy while that may run) key chats run on it; otherwise on the server, as before. Only with a
  // key here: agy would otherwise sign in with its own saved login. gcloud stays on the server,
  // since agy's gcloud mode also reads that login, for its side calls and whenever ADC fails.
  if (savedKeyMethod(input.settings.antigravityChatAuth)) {
    const onAgy =
      isAbsolute(command) &&
      (await agyServesOrcaHome(command, env)) &&
      // The host's scrub drops GEMINI_API_KEY from `env`; a launch on Orca's home keeps it.
      (await agyOrcaHomeKeyPresent(input.shellEnv ?? env))
    noteAgyOrcaHomeRoute(onAgy)
    return onAgy ? ON_AGY_ORCA_HOME : ON_SERVER
  }
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
