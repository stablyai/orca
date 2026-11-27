import type {
  AntigravityAccountState,
  AntigravityAccountTarget
} from '../../../../../shared/agent-accounts/antigravity/antigravity-account-types'
import {
  forgetAntigravityHostAcpChecks,
  isAntigravityHostAccountHome,
  readyAntigravityHostAcpVersion
} from '../../../../antigravity/antigravity-host-acp'
import { isAntigravityAgyOrcaAccountHome } from '../../../../antigravity/antigravity-agy-orca-home'
import { getStructuredAgentSessionHost } from '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { resolveHostStructuredAgentLaunchEnvironment } from '../../../agent-session/launch/structured-agent-launch-support'
import { acpHostBackendInput } from '../../../../acp/launch/acp-launch-command'
import { ANTIGRAVITY_LAUNCH_SPEC } from '../../../../antigravity/antigravity-acp-launch-spec'
import { getProfileUserDataPath } from '../../../../orca-profiles/profile-storage-paths'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import {
  antigravityAgySignIn,
  savedChatAuthIsPersonal,
  savedChatAuthUsesAgyLogin
} from '../../../../antigravity/antigravity-chat-route'
import { withTimeout } from '../../../../../shared/concurrency/promise-timeout-fallback'
import { antigravityUsesFileStoreAsync } from '../../../../antigravity/native-file-credentials'

const CHAT_BACKEND_WAIT_MS = 1_500
const LAUNCH_HOME_WAIT_MS = 1_000

/** Where new chats on this host run, and agy's own sign-in for those on its home. */
async function hostChatRoute(runtime: OrcaRuntimeService) {
  const settings = runtime.requireStore().getSettings()
  const orcaHome = !savedChatAuthIsPersonal(settings.antigravityChatAuth)
  // Enterprise runs on Orca's home but with agy's login, so its sign-in is read too.
  if (orcaHome && !savedChatAuthUsesAgyLogin(settings.antigravityChatAuth)) {
    return { agy: false as const, orcaHome }
  }
  const env = await resolveHostStructuredAgentLaunchEnvironment('antigravity', settings)
  // Someone is looking (a chat or Settings), so agy may be started once to answer.
  const input = await acpHostBackendInput(
    ANTIGRAVITY_LAUNCH_SPEC,
    env,
    getProfileUserDataPath(),
    settings,
    { startsProgram: true }
  )
  return { agy: input ? await antigravityAgySignIn(input) : ('unknown' as const), orcaHome }
}

/** Asks agy's sign-in for Google-account chats without waiting, so every surface that subscribes
 *  to it (a chat, Settings) gets an answer, not only the one that asked first. */
export function readAgySignInInBackground(runtime: OrcaRuntimeService): void {
  void hostChatRoute(runtime).catch((error: unknown) =>
    console.warn("[antigravity] agy's sign-in couldn't be read:", error)
  )
}

/** The HOME new host agy chats launch with, when it shares the login an account switch changes;
 *  a login shell or the agent's settings can set one other than Orca's own. Unknown after
 *  LAUNCH_HOME_WAIT_MS, or when unreadable. */
export function sharedAgyLaunchHome(runtime: OrcaRuntimeService): Promise<string | undefined> {
  const read = async (): Promise<string | undefined> => {
    // agy's login is in the system keyring, which every HOME shares, unless it keeps a file per HOME.
    if (process.platform === 'win32' || (await antigravityUsesFileStoreAsync(process.env))) {
      return undefined
    }
    const settings = runtime.requireStore().getSettings()
    const env = await resolveHostStructuredAgentLaunchEnvironment('antigravity', settings)
    // The launch environment can keep a file per HOME even where Orca's own uses the keyring.
    return (await antigravityUsesFileStoreAsync(env)) ? undefined : (env.HOME ?? env.USERPROFILE)
  }
  return withTimeout(
    read().catch(() => undefined),
    LAUNCH_HOME_WAIT_MS,
    undefined
  )
}

/** Adds whether new chats on this host run on agy, and so on the account these rows switch. */
export async function withAntigravityChatBackend(
  runtime: OrcaRuntimeService,
  target: AntigravityAccountTarget,
  state: AntigravityAccountState
): Promise<AntigravityAccountState> {
  // Chats never run in WSL.
  if (target.runtime !== 'host') {
    return state
  }
  // A cold agy check takes seconds; the rows don't wait for it, and a later refresh shows it.
  const route = await withTimeout(
    hostChatRoute(runtime).catch(() => ({ agy: 'unknown' as const, orcaHome: false })),
    CHAT_BACKEND_WAIT_MS,
    null
  )
  if (route === null) {
    return state
  }
  const agy = route.orcaHome ? false : route.agy
  const version = agy === 'signedIn' ? readyAntigravityHostAcpVersion() : null
  return {
    ...state,
    chatUsesAgy: agy === 'signedIn',
    chatAgySignedOut: agy === 'signedOut',
    ...(route.orcaHome ? { chatKeyOnAgy: true } : {}),
    ...(version ? { chatAgyVersion: version } : {})
  }
}

/** A running `agy acp` may keep the login it started with, so idle chats on agy stop and resume on
 *  the newly selected account at their next send; busy ones keep their turn (#43375). */
export function restartIdleAgyChats(target: AntigravityAccountTarget): void {
  if (target.runtime !== 'host') {
    return
  }
  // The cached answer vouched for the previous login.
  forgetAntigravityHostAcpChecks()
  const host = getStructuredAgentSessionHost()
  if (!host) {
    return
  }
  for (const id of host.loadedSessionIds()) {
    const home =
      host.sessionAgent(id) === 'antigravity' ? host.childAccountHome(id, true) : undefined
    // Orca's homes use agy's Google login too (Enterprise, the retired server's chats).
    if (home && (isAntigravityHostAccountHome(home) || isAntigravityAgyOrcaAccountHome(home))) {
      void host.releaseIdleSession(id, true).catch((error: unknown) => {
        console.warn('[antigravity] an idle chat kept the previous account:', error)
      })
    }
  }
}
