// Gemini API key chats run on agy when it is here, which offers newer models than Orca's server. agy runs them in a home Orca owns (`--gemini-dir`), whose
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
import { AcpListingRefused } from '../acp/discovery/acp-listing-account'
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
import { envHasGeminiApiKey } from './antigravity-agy-orca-home-credential'
import { writeAntigravityChatSettings } from './antigravity-chat-account'
import {
  AGY_HOME_SKILL_FOLDERS,
  antigravityUserHome,
  copyAntigravityUserRules,
  linkAntigravityUserSkills
} from './antigravity-chat-user-skills'

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

const METHOD_CHANGED =
  'This chat ran on agy with a Gemini API key, and Antigravity now signs in another way. Start a new chat, or switch the sign-in method back under Settings → Accounts → Antigravity.'

const folder = hostFolderAccountBinding(VARIABLE, ANTIGRAVITY_AGY_CHAT_HOME_FOLDER, [
  ANTIGRAVITY_ACP_HOME
])

/** The home's account binding: settings.json for the saved method before every start or listing.
 *  Only the key method runs here, and only with a key: agy would otherwise sign in with its own
 *  saved login. Chats are refused with the reason; listings aren't run. */
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
    // A chat pinned here keeps this home after the method moves to gcloud or a Google account, which
    // agy would back with its own saved login; Orca never writes another method here.
    if (auth.method !== 'gemini-api-key') {
      throw refusal(METHOD_CHANGED, purpose)
    }
    // New chats without a key run on Orca's server; one pinned here never runs without it. Only
    // the final launch env counts: a saved key that didn't decrypt into it leaves agy keyless.
    if (!envHasGeminiApiKey(env)) {
      throw refusal(await missingKey(), purpose)
    }
    await folder.prepare?.(env)
    const user = antigravityUserHome(env)
    await linkAntigravityUserSkills(home, user, process.platform, AGY_HOME_SKILL_FOLDERS)
    // agy reads the user's rules from its home, as from ~/.gemini.
    await copyAntigravityUserRules(home, user)
    await writeAntigravityChatSettings(home, auth, env, assertCurrent)
  }
}

// Keyed by path; size and mtime tell a new binary apart, so an update is read again.
const versions = new Map<string, { identity: string; serves: Promise<boolean>; until?: number }>()
// A version that couldn't be read (a slow cold start, a timeout) is asked again after this.
const UNREAD_VERSION_RETRY_MS = 60_000

/** Whether `command` is an agy new enough to run on Orca's home; `agy --version` is read once per
 *  binary. An unreadable version doesn't qualify for a minute, so those chats stay on Orca's server
 *  meanwhile. */
export async function agyServesOrcaHome(
  command: string,
  env: Record<string, string>,
  read: typeof readAgentCliVersion = readAgentCliVersion,
  now: () => number = Date.now
): Promise<boolean> {
  const stats = await stat(command).catch(() => null)
  if (!stats?.isFile()) {
    return false
  }
  const identity = `${stats.size}:${stats.mtimeMs}`
  const known = versions.get(command)
  if (known?.identity === identity && (known.until === undefined || now() < known.until)) {
    return known.serves
  }
  const entry: { identity: string; serves: Promise<boolean>; until?: number } = {
    identity,
    serves: Promise.resolve(false)
  }
  const unread = () => {
    entry.until = now() + UNREAD_VERSION_RETRY_MS
    return false
  }
  entry.serves = read({ program: command, cwd: env.HOME ?? process.cwd(), env }).then(
    ({ version }) =>
      version !== null && isValidAppVersion(version)
        ? compareAppVersions(version, AGY_ORCA_HOME_MINIMUM_VERSION) >= 0
        : unread(),
    unread
  )
  versions.set(command, entry)
  return entry.serves
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
