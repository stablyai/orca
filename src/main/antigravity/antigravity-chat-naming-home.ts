// Chat naming on agy runs each time on a home of its own, never agy's ~/.gemini or Orca's chat home,
// so its session lands in no history anyone reads; Orca removes the home once agy exits.

import { stat } from 'node:fs/promises'
import type { AcpLaunchSpec, AcpTextTaskHome } from '../acp/launch/acp-launch-contract'
import type { AgentSessionAccountHome } from '../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import { resolveAntigravityChatAuthConfig } from '../../shared/agent-accounts/antigravity/antigravity-chat-auth-config'
import { agyCredentialPresence } from './agy-credential-presence'
import { antigravityKeyringFallbackMarker } from './native-credential-backend'
import { agySignsInWithPersonalGoogle, isAntigravityHostAccountHome } from './antigravity-host-acp'
import {
  agyOrcaHomeArgs,
  antigravityAgyNamingAccount,
  antigravityOrcaHomeFolder
} from './antigravity-agy-orca-home'
import { isAgySignInSelector } from './antigravity-agy-orca-home-environment'
import { antigravityUserHome } from './antigravity-chat-user-skills'

/** A naming run for a chat on agy's own home or one Orca owns, signed in as that chat is. */
export function antigravityChatNamingHome(
  orcaHomeSpec: AcpLaunchSpec,
  chatHome: AgentSessionAccountHome,
  folder: string
): AcpTextTaskHome | null {
  const onAgyHome = isAntigravityHostAccountHome(chatHome)
  if (!onAgyHome && !antigravityOrcaHomeFolder(chatHome)) {
    return null
  }
  const home = { variable: 'GEMINI_HOME', path: folder }
  return {
    home,
    spec: {
      ...orcaHomeSpec,
      account: antigravityAgyNamingAccount(folder),
      args: (options) => [...orcaHomeSpec.args(options), ...agyOrcaHomeArgs(home)]
    },
    admits: (launch) => admitsAntigravityNaming(onAgyHome, launch)
  }
}

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false
  )

/** Naming never asks for a keyring unlock, and runs only where its home signs in as the chat. */
export async function admitsAntigravityNaming(
  chatOnAgyHome: boolean,
  launch: Parameters<AcpTextTaskHome['admits']>[0]
): Promise<boolean> {
  const user = antigravityUserHome(launch.env)
  const { method } = resolveAntigravityChatAuthConfig(launch.antigravityChatAuth)
  // On its own home agy follows its own settings and sign-in variables, which a naming home drops.
  if (
    chatOnAgyHome &&
    (method !== 'oauth-personal' ||
      launch.envToDelete.some((key) => isAgySignInSelector(key)) ||
      !(await agySignsInWithPersonalGoogle(user)))
  ) {
    return false
  }
  // After a keyring timeout agy may read either store, and a naming home lacks the note saying so.
  if (await exists(antigravityKeyringFallbackMarker(user))) {
    return false
  }
  const presence = await agyCredentialPresence(user)
  const google = method === 'oauth-personal' || method === 'oauth-business'
  return presence === 'present' || (presence === 'absent' && !google)
}
