// Chats on any method but a Google account run agy in a home Orca owns (`--gemini-dir`), whose
// settings.json picks the method, so the person's own ~/.gemini login and settings stay untouched.

import { join } from 'node:path'
import type { AntigravityChatAuthConfig } from '../../shared/agent-accounts/antigravity/antigravity-chat-auth-config'
import { resolveAntigravityChatAuthConfig } from '../../shared/agent-accounts/antigravity/antigravity-chat-auth-config'
import {
  isLegacyAgentSessionAccountHome,
  type AgentSessionAccountHome
} from '../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import { ANTIGRAVITY_ACP_HOME } from '../../shared/agent-session/lifecycle/provider-handles/antigravity-session-origin'
import { hostFolderAccountBinding, type AcpAccountBinding } from '../acp/launch/acp-account-binding'
import { AcpListingRefused } from '../acp/discovery/acp-listing-account'
import { AgentSessionAcquisitionRefusal } from '../native-chat/agent-session-wire/providers/structured-agent-session-adapter-errors'
import {
  providerDiagnostic,
  withProviderDiagnostic
} from '../../shared/agent-session/failures/agent-session-failure'
import { hasAntigravityChatApiKey } from './antigravity-chat-api-key-store'
import { envHasGeminiApiKey } from './antigravity-chat-credential'
import { copyAgyLoginIntoOrcaHome } from './agy-login-copy'
import { restoreAntigravityAccountForChat } from './native-account-launch'
import { ANTIGRAVITY_CHAT_HOME_FOLDER } from './antigravity-chat-home'
import { writeAntigravityChatSettings } from './antigravity-chat-account'
import {
  AGY_HOME_SKILL_FOLDERS,
  antigravityUserHome,
  copyAntigravityUserRules,
  linkAntigravityUserSkills
} from './antigravity-chat-user-skills'

/** Under Orca's data folder: new chats on any method but a Google account run here. */
export const ANTIGRAVITY_AGY_CHAT_HOME_FOLDER = 'antigravity-agy-chat'
const VARIABLE = 'GEMINI_HOME'
const ORCA_HOME_FOLDERS = [ANTIGRAVITY_AGY_CHAT_HOME_FOLDER, ANTIGRAVITY_CHAT_HOME_FOLDER]

export function antigravityAgyOrcaAccountHome(stateDirectory: string): AgentSessionAccountHome {
  return { variable: VARIABLE, path: join(stateDirectory, ANTIGRAVITY_AGY_CHAT_HOME_FOLDER) }
}

/** The Orca home `home` is: this one, or the one Orca's retired server kept its chats in, which
 *  agy reads in place. */
export function antigravityOrcaHomeFolder(home: AgentSessionAccountHome): string | null {
  if (!isLegacyAgentSessionAccountHome(home) || home.variable !== VARIABLE) {
    return null
  }
  const name = home.path.split(/[\\/]+/).findLast(Boolean)
  return name && ORCA_HOME_FOLDERS.includes(name) ? name : null
}

export function isAntigravityAgyOrcaAccountHome(home: AgentSessionAccountHome): boolean {
  return antigravityOrcaHomeFolder(home) !== null
}

/** Points agy at the home instead of ~/.gemini; it reads settings.json from the app data folder. */
export function agyOrcaHomeArgs(home: AgentSessionAccountHome): string[] {
  return isLegacyAgentSessionAccountHome(home)
    ? ['--gemini-dir', home.path, '--app-data-dir', ANTIGRAVITY_ACP_HOME]
    : []
}

// Sign in opens Settings, where the method and key are.
function refusal(text: string, purpose: 'chat' | 'listing'): Error {
  if (purpose === 'listing') {
    return new AcpListingRefused(text)
  }
  const refused = new AgentSessionAcquisitionRefusal(text, 'notSignedIn', 'managed')
  const detail = providerDiagnostic(text, 'person')
  return detail ? withProviderDiagnostic(refused, detail) : refused
}

async function missingKey(): Promise<string> {
  return (await hasAntigravityChatApiKey())
    ? "The Gemini API key saved for Antigravity can't be read on this computer. Save it again under Settings → Accounts → Antigravity."
    : "No Gemini API key is saved for Antigravity, and GEMINI_API_KEY isn't set. Add a key under Settings → Accounts → Antigravity."
}

const isGoogle = (method: AntigravityChatAuthConfig['method']): boolean =>
  method === 'oauth-personal' || method === 'oauth-business'

/** An Orca home's binding: before every start or listing, settings.json for the saved method and
 *  that method's credential. A key chat without a key is refused: agy would fall back to its own
 *  saved login. A Google method uses agy's login; gcloud's ADC is agy's to find. */
function orcaHomeAccount(folderName: string): AcpAccountBinding {
  const folder = hostFolderAccountBinding(VARIABLE, folderName, [ANTIGRAVITY_ACP_HOME])
  return {
    ...folder,
    prepare: async (env, config, assertCurrent, purpose = 'chat') => {
      const auth = resolveAntigravityChatAuthConfig(config)
      const home = env[VARIABLE]
      if (!home) {
        throw new Error(`${VARIABLE} is not set`)
      }
      // Only the final launch env counts: a saved key that didn't decrypt into it leaves agy keyless.
      if (auth.method === 'gemini-api-key' && !envHasGeminiApiKey(env)) {
        throw refusal(await missingKey(), purpose)
      }
      await folder.prepare?.(env)
      const user = antigravityUserHome(env)
      await linkAntigravityUserSkills(home, user, process.platform, AGY_HOME_SKILL_FOLDERS)
      // agy reads the user's rules from its home, as from ~/.gemini.
      await copyAntigravityUserRules(home, user)
      await writeAntigravityChatSettings(home, auth, env, assertCurrent)
      // Google chats here use agy's login too, so they follow the selected account like terminals.
      if (purpose === 'chat' && isGoogle(auth.method)) {
        await restoreAntigravityAccountForChat(env)
      }
      await copyAgyLoginIntoOrcaHome(home, user, isGoogle(auth.method))
    }
  }
}

export const antigravityAgyOrcaAccount = orcaHomeAccount(ANTIGRAVITY_AGY_CHAT_HOME_FOLDER)

/** Chats Orca's retired server started; agy resumes them in place. */
export const antigravityLegacyOrcaAccount = orcaHomeAccount(ANTIGRAVITY_CHAT_HOME_FOLDER)
