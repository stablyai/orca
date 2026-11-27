import { readdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  HERMES_PROFILE_NAME,
  hermesProfileRoot
} from '../../shared/agent-launch/startup/hermes-profile'
import { isLegacyAgentSessionAccountHome } from '../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import {
  absoluteConversationStore,
  type StructuredAgentTranscriptImport
} from '../native-chat/conversation-adoption/structured-agent-cli-conversations'
import { admitTranscriptPath } from '../native-chat/transcript-discovery/transcript-path-admission'
import { resolveHermesActiveProfileHome } from './hermes-default-home'

async function profileHomes(root: string): Promise<string[]> {
  try {
    return (await readdir(join(root, 'profiles'), { withFileTypes: true }))
      .filter(
        (entry) =>
          (entry.isDirectory() || entry.isSymbolicLink()) &&
          entry.name !== 'default' &&
          HERMES_PROFILE_NAME.test(entry.name)
      )
      .map((entry) => join(root, 'profiles', entry.name))
      .sort()
  } catch {
    return []
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    ) {
      return false
    }
    throw error
  }
}

// Every surface's sessions share one state.db per profile, so a Session History row may sit in
// any profile of the selected chat's root. The chat then runs with HERMES_HOME at that profile.
export const HERMES_TRANSCRIPT_IMPORT: StructuredAgentTranscriptImport = {
  readableContext: { kind: 'container' },
  conversationStore: ({ accountHome }) =>
    isLegacyAgentSessionAccountHome(accountHome)
      ? absoluteConversationStore(join(accountHome.path, 'state.db'))
      : null,
  admitTranscriptPath: async ({ store: dbPath, transcriptPath }) => {
    const [expected, actual] = await Promise.all([
      admitTranscriptPath(dirname(dbPath), dbPath),
      admitTranscriptPath(dirname(dbPath), transcriptPath)
    ])
    return expected && actual && expected.path === actual.path ? actual.path : null
  },
  accountHomeCandidates: async ({ selectedAccountHome }) => {
    if (!isLegacyAgentSessionAccountHome(selectedAccountHome)) {
      return []
    }
    const root = hermesProfileRoot(selectedAccountHome.path)
    // `hermes acp` under a root HERMES_HOME runs the sticky `hermes profile use` choice, so the
    // root's own store can only be adopted while no named profile is sticky.
    const rootRuns = (await resolveHermesActiveProfileHome(root)) === root
    const homes = [selectedAccountHome.path, root, ...(await profileHomes(root))].filter(
      (home) => home !== root || rootRuns
    )
    return [...new Set(homes)].map((path) => ({ variable: selectedAccountHome.variable, path }))
  },
  findTranscript: async ({ providerSessionId, store: dbPath }) => {
    if (!(await isFile(dbPath))) {
      return null
    }
    const { hasHermesSessionViaWorker } =
      await import('../ai-vault/scanners/hermes/session-scanner-hermes-worker')
    return (await hasHermesSessionViaWorker({ dbPath, sessionId: providerSessionId }))
      ? dbPath
      : null
  }
}
