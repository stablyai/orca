import type { AiVaultSession } from '../../../../shared/ai-vault/contracts/ai-vault-types'
import type { SessionFileCandidate } from '../../session-scanner-types'
import type { OpenCodeSqliteCaptureValue } from '../opencode/reader-transport/session-scanner-opencode-sqlite-worker-protocol'
import {
  captureForHost,
  listForHost,
  parseForHost,
  type SqliteCaptureArgs,
  type SqliteListArgs,
  type SqliteParseArgs
} from '../opencode/reader-transport/session-scanner-opencode-sqlite-worker-spawn'

// Hermes' state.db is read by the same off-thread SQLite reader as OpenCode's stores, WSL guests included.

export const listHermesSqliteSessionsViaWorker = (
  args: SqliteListArgs
): Promise<SessionFileCandidate[]> => listForHost({ ...args, agent: 'hermes' })

export const parseHermesSqliteSessionViaWorker = (
  args: SqliteParseArgs
): Promise<AiVaultSession | null> => parseForHost({ ...args, agent: 'hermes' })

export const captureHermesSqliteSessionViaWorker = (
  args: SqliteCaptureArgs
): Promise<OpenCodeSqliteCaptureValue> => captureForHost({ ...args, agent: 'hermes' })
