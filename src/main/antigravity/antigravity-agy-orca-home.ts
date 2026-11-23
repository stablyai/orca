// Gemini API key and Google Agent Platform (gcloud) chats run on agy when it is here, which offers
// newer models than Orca's server. agy runs them in a home Orca owns (`--gemini-dir`), whose
// settings.json picks the method, so the person's own ~/.gemini login and settings stay untouched.

import { basename, join } from 'node:path'
import { rm, stat } from 'node:fs/promises'
import type { AntigravityChatAuthConfig } from '../../shared/agent-accounts/antigravity/antigravity-chat-auth-config'
import { resolveAntigravityChatAuthConfig } from '../../shared/agent-accounts/antigravity/antigravity-chat-auth-config'
import {
  isLegacyAgentSessionAccountHome,
  type AgentSessionAccountHome
} from '../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import { ANTIGRAVITY_ACP_HOME } from '../../shared/agent-session/lifecycle/provider-handles/antigravity-session-origin'
import { hostFolderAccountBinding } from '../acp/launch/acp-account-binding'
import type { AcpListingSession } from '../acp/discovery/acp-model-discovery-policy'
import { AgentSessionAcquisitionRefusal } from '../native-chat/agent-session-wire/providers/structured-agent-session-adapter-errors'
import {
  providerDiagnostic,
  withProviderDiagnostic
} from '../../shared/agent-session/failures/agent-session-failure'
import { readAgentCliVersion } from '../agent-launch/preflight/agent-cli-version-probe'
import {
  compareAppVersions,
  isValidAppVersion
} from '../../shared/app-lifecycle/identity/app-version'
import { hasAntigravityChatApiKey } from './antigravity-chat-api-key-store'
import { envValue } from './antigravity-chat-credential'
import { writeAntigravityChatSettings } from './antigravity-chat-account'
import { antigravityUserHome, linkAntigravityUserSkills } from './antigravity-chat-user-skills'

/** Under Orca's data folder; apart from the server's home, whose chats keep running there. */
export const ANTIGRAVITY_AGY_CHAT_HOME_FOLDER = 'antigravity-agy-chat'
const VARIABLE = 'GEMINI_HOME'

/** The oldest agy that runs a chat on a home it is given (`--gemini-dir`/`--app-data-dir`). */
export const AGY_ORCA_HOME_MINIMUM_VERSION = '1.5.5'

export function antigravityAgyOrcaAccountHome(stateDirectory: string): AgentSessionAccountHome {
  return { variable: VARIABLE, path: join(stateDirectory, ANTIGRAVITY_AGY_CHAT_HOME_FOLDER) }
}

export function isAntigravityAgyOrcaAccountHome(home: AgentSessionAccountHome): boolean {
  return (
    isLegacyAgentSessionAccountHome(home) &&
    home.variable === VARIABLE &&
    home.path.split(/[\\/]+/).findLast(Boolean) === ANTIGRAVITY_AGY_CHAT_HOME_FOLDER
  )
}

/** Points agy at the home instead of ~/.gemini; it reads settings.json from the app data folder. */
export function agyOrcaHomeArgs(home: AgentSessionAccountHome): string[] {
  return isLegacyAgentSessionAccountHome(home)
    ? ['--gemini-dir', home.path, '--app-data-dir', ANTIGRAVITY_ACP_HOME]
    : []
}

function missingKey(text: string): Error {
  const refusal = new AgentSessionAcquisitionRefusal(text, 'notSignedIn', 'managed')
  const detail = providerDiagnostic(text, 'person')
  return detail ? withProviderDiagnostic(refusal, detail) : refusal
}

const folder = hostFolderAccountBinding(VARIABLE, ANTIGRAVITY_AGY_CHAT_HOME_FOLDER, [
  ANTIGRAVITY_ACP_HOME
])

/** The home's account binding: settings.json for the saved method before every start or listing.
 *  A key chat without a key never runs here (agy has no other sign-in in this home), so it is
 *  refused with the reason; gcloud is left to agy, whose ADC lookup only it can answer. */
export const antigravityAgyOrcaAccount = {
  ...folder,
  prepare: async (
    env: Readonly<Record<string, string>>,
    config?: AntigravityChatAuthConfig,
    assertCurrent?: () => void,
    purpose: 'chat' | 'listing' = 'chat'
  ): Promise<void> => {
    const auth = resolveAntigravityChatAuthConfig(config)
    const home = env[VARIABLE]
    if (!home) {
      throw new Error(`${VARIABLE} is not set`)
    }
    if (
      purpose === 'chat' &&
      auth.method === 'gemini-api-key' &&
      !envValue(env, 'GEMINI_API_KEY')?.trim()
    ) {
      throw missingKey(
        (await hasAntigravityChatApiKey())
          ? "The Gemini API key saved for Antigravity can't be read on this computer. Save it again under Settings → Accounts → Antigravity."
          : "No Gemini API key is saved for Antigravity, and GEMINI_API_KEY isn't set. Add a key under Settings → Accounts → Antigravity."
      )
    }
    await folder.prepare?.(env)
    await linkAntigravityUserSkills(home, antigravityUserHome(env))
    await writeAntigravityChatSettings(home, auth, env, assertCurrent)
  }
}

// Keyed by path; size and mtime tell a new binary apart, so an update is read again.
const versions = new Map<string, { identity: string; serves: Promise<boolean> }>()

/** Whether `command` is an agy new enough to run on Orca's home; `agy --version` is read once per
 *  binary. An unreadable version doesn't qualify, so those chats stay on Orca's server. */
export async function agyServesOrcaHome(
  command: string,
  env: Record<string, string>,
  read: typeof readAgentCliVersion = readAgentCliVersion
): Promise<boolean> {
  const stats = await stat(command).catch(() => null)
  if (!stats?.isFile()) {
    return false
  }
  const identity = `${stats.size}:${stats.mtimeMs}`
  const known = versions.get(command)
  if (known?.identity === identity) {
    return known.serves
  }
  const serves = read({ program: command, cwd: env.HOME ?? process.cwd(), env }).then(
    ({ version }) =>
      version !== null &&
      isValidAppVersion(version) &&
      compareAppVersions(version, AGY_ORCA_HOME_MINIMUM_VERSION) >= 0,
    () => false
  )
  versions.set(command, { identity, serves })
  return serves
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CONVERSATION_FILES = ['.db', '.db-wal', '.db-shm', '.db-journal']

/** agy keeps every session; a model listing's own one is removed from the home Orca owns. */
export async function discardAgyOrcaListingSession({
  sessionId,
  accountHomePath
}: AcpListingSession): Promise<void> {
  if (
    !SESSION_ID.test(sessionId) ||
    basename(accountHomePath) !== ANTIGRAVITY_AGY_CHAT_HOME_FOLDER
  ) {
    return
  }
  const home = join(accountHomePath, ANTIGRAVITY_ACP_HOME)
  const conversation = join(home, 'conversations', sessionId)
  // Only a session that exists here is the listing's; nothing else is touched.
  if (!(await stat(`${conversation}.db`).catch(() => null))) {
    return
  }
  await Promise.all([
    ...CONVERSATION_FILES.map((suffix) => rm(`${conversation}${suffix}`, { force: true })),
    rm(join(home, 'brain', sessionId), { recursive: true, force: true }),
    rm(join(home, 'annotations', `${sessionId}.pbtxt`), { force: true })
  ])
}
