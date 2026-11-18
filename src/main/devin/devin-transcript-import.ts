import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { admitTranscriptPath } from '../native-chat/transcript-discovery/transcript-path-admission'
import { isENOENT } from '../filesystem/local-file-io/filesystem-path-containment'
import {
  isLegacyAgentSessionAccountHome,
  type AgentSessionAccountHome
} from '../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import type { StructuredAgentTranscriptImport } from '../native-chat/conversation-adoption/structured-agent-cli-conversations'
import { readOpenCodeDatabase } from '../ai-vault/scanners/opencode/sqlite/session-scanner-opencode-sqlite-open'
import { columnExists, tableExists } from '../opencode-usage/schema-helpers'
import {
  getManagedDataAccountService,
  type ManagedDataAccountService
} from '../managed-data-accounts/service'
import { defaultDevinDataHome, devinDataHomeVariable } from './devin-acp-account-binding'

type DevinImportDeps = {
  managedAccounts?: () => Pick<ManagedDataAccountService, 'transcriptEnvironments'>
  platform?: NodeJS.Platform
  homePath?: string
}

// The database is evidence only: session/load replays history, so nothing decodes it here.
const DEVIN_SESSIONS_DB = 'sessions.db'

function cliDirectory(accountHome: AgentSessionAccountHome): string | null {
  return isLegacyAgentSessionAccountHome(accountHome)
    ? join(accountHome.path, 'devin', 'cli')
    : null
}

function accountHome(variable: string, path: string | undefined): AgentSessionAccountHome | null {
  const trimmed = path?.trim()
  return trimmed && isAbsolute(trimmed) ? { variable, path: trimmed } : null
}

/** Account roots that may hold the session: the selection, every managed account, the default. */
function candidates(
  deps: DevinImportDeps,
  selectedAccountHome: AgentSessionAccountHome
): AgentSessionAccountHome[] {
  const platform = deps.platform ?? process.platform
  const variable = devinDataHomeVariable(platform)
  const managed = deps.managedAccounts ?? getManagedDataAccountService
  return [
    selectedAccountHome,
    ...managed()
      .transcriptEnvironments('devin')
      .flatMap((env) => {
        const home = accountHome(variable, env[variable])
        return home ? [home] : []
      }),
    ...(() => {
      const home = accountHome(
        variable,
        defaultDevinDataHome(
          platform,
          deps.homePath ?? process.env.HOME ?? process.env.USERPROFILE ?? homedir()
        )
      )
      return home ? [home] : []
    })()
  ]
}

function sessionRecorded(dbPath: string, providerSessionId: string): boolean {
  return readOpenCodeDatabase({
    dbPath,
    read: (db) =>
      tableExists(db, 'sessions') &&
      columnExists(db, 'sessions', 'id') &&
      db.prepare('SELECT 1 AS present FROM sessions WHERE id = ?').get(providerSessionId) !==
        undefined
  })
}

export function devinTranscriptImport(deps: DevinImportDeps = {}): StructuredAgentTranscriptImport {
  return {
    readableContext: { kind: 'container' },
    conversationStore: ({ accountHome: home }) => cliDirectory(home),
    admitTranscriptPath: async ({ store, transcriptPath }) =>
      (await admitTranscriptPath(store, transcriptPath))?.path ?? null,
    accountHomeCandidates: ({ selectedAccountHome }) => candidates(deps, selectedAccountHome),
    findTranscript: async ({ providerSessionId, store }) => {
      if (!providerSessionId) {
        return null
      }
      const dbPath = join(store, DEVIN_SESSIONS_DB)
      try {
        if (!(await stat(dbPath)).isFile()) {
          return null
        }
      } catch (error) {
        if (isENOENT(error)) {
          return null
        }
        throw error
      }
      return sessionRecorded(dbPath, providerSessionId) ? dbPath : null
    }
  }
}
