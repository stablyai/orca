import type {
  AntigravityAccountState,
  AntigravityAccountTarget
} from '../../../../../shared/agent-accounts/antigravity/antigravity-account-types'
import {
  forgetAntigravityHostAcpChecks,
  isAntigravityHostAccountHome,
  readyAntigravityHostAcpVersion
} from '../../../../antigravity/antigravity-host-acp'
import { getStructuredAgentSessionHost } from '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { resolveHostStructuredAgentLaunchEnvironment } from '../../../agent-session/launch/structured-agent-launch-support'
import { acpHostBackendInput } from '../../../../acp/launch/acp-launch-command'
import {
  ANTIGRAVITY_LAUNCH_SPEC,
  antigravityHostChatRoute
} from '../../../../antigravity/antigravity-acp-launch-spec'
import { getProfileUserDataPath } from '../../../../orca-profiles/profile-storage-paths'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import {
  savedChatAuthIsPersonal,
  type AntigravityChatRoute
} from '../../../../antigravity/antigravity-chat-route'
import { withTimeout } from '../../../../../shared/concurrency/promise-timeout-fallback'
import { antigravityUsesFileStoreAsync } from '../../../../antigravity/native-file-credentials'

const CHAT_BACKEND_WAIT_MS = 1_500
const LAUNCH_HOME_WAIT_MS = 1_000

/** Where new chats on this host run; an unreadable answer reads as Orca's server. */
async function hostChatRoute(runtime: OrcaRuntimeService) {
  const settings = runtime.requireStore().getSettings()
  const env = await resolveHostStructuredAgentLaunchEnvironment('antigravity', settings)
  const input = await acpHostBackendInput(
    ANTIGRAVITY_LAUNCH_SPEC,
    env,
    getProfileUserDataPath(),
    settings
  )
  // The settings the route answered for go with its answer, so the two never mix snapshots.
  const route = input ? await antigravityHostChatRoute(input) : null
  return { agy: route?.agy ?? false, orcaHome: route?.orcaHome === true, settings }
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

/** Which sign-in new Google-account chats use: agy whenever the route sends them there, signed in
 *  or not and installed or not, else Orca's server; none for another saved method. */
export function antigravityGoogleSignInInUse(
  settings: Pick<GlobalSettings, 'antigravityChatAuth'>,
  agy: AntigravityChatRoute['agy']
): 'agy' | 'orca' | undefined {
  if (!savedChatAuthIsPersonal(settings.antigravityChatAuth)) {
    return undefined
  }
  return agy === false ? 'orca' : 'agy'
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
    hostChatRoute(runtime).catch(() => ({
      agy: false as const,
      orcaHome: false,
      settings: runtime.requireStore().getSettings()
    })),
    CHAT_BACKEND_WAIT_MS,
    null
  )
  if (route === null) {
    return state
  }
  const { agy } = route
  const version = agy === 'signedIn' ? readyAntigravityHostAcpVersion() : null
  const inUse = antigravityGoogleSignInInUse(route.settings, agy)
  return {
    ...state,
    chatUsesAgy: agy === 'signedIn',
    chatAgySignedOut: agy === 'signedOut',
    ...(route.orcaHome ? { chatKeyOnAgy: true } : {}),
    ...(inUse ? { chatGoogleSignInInUse: inUse } : {}),
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
    if (home && isAntigravityHostAccountHome(home)) {
      void host.releaseIdleSession(id, true).catch((error: unknown) => {
        console.warn('[antigravity] an idle chat kept the previous account:', error)
      })
    }
  }
}
