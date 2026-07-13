import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import { discoverFiles } from './session-scanner-discovery'
import type { AiVaultScanOptions, SessionFileDiscovery } from './session-scanner-types'

// Why: Antigravity CLI shares the ~/.gemini root but stores each conversation
// as its own SQLite DB under antigravity-cli/conversations, unrelated to the
// Gemini CLI's ~/.gemini/tmp JSON transcripts.
const ANTIGRAVITY_CONVERSATIONS_DIR = join(homedir(), '.gemini', 'antigravity-cli', 'conversations')
const CONVERSATION_DB_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.db$/i

export function antigravityDiscoveries(
  options: AiVaultScanOptions,
  wslHomeDirs: readonly string[],
  limit: number,
  issues: AiVaultScanIssue[]
): Promise<SessionFileDiscovery>[] {
  return sessionRootDirs(
    options.antigravityConversationsDir ?? ANTIGRAVITY_CONVERSATIONS_DIR,
    wslHomeDirs,
    ['.gemini', 'antigravity-cli', 'conversations']
  ).map((rootDir) =>
    discoverFiles({
      rootDir,
      limit,
      agent: 'antigravity',
      issues,
      extensions: ['.db'],
      // Why: transcripts are per-conversation UUID DBs; the .db-wal/.db-shm
      // sidecars and the conversation_summaries index must not be treated as
      // sessions, so match only the UUID.db filename.
      filePredicate: (path) => CONVERSATION_DB_RE.test(path)
    })
  )
}

function sessionRootDirs(
  hostRootDir: string,
  wslHomeDirs: readonly string[],
  segments: readonly string[]
): string[] {
  return [hostRootDir, ...wslHomeDirs.map((homeDir) => join(homeDir, ...segments))]
}
