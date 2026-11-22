import { basename, dirname, join } from 'node:path'
import type {
  AiVaultScanIssue,
  AiVaultSession
} from '../../../../shared/ai-vault/contracts/ai-vault-types'
import { isCursorAcpSessionStorePath } from '../../../../shared/ai-vault/session-display/cursor-acp-session-path'
import {
  cursorAcpSessionMetaPath,
  readCursorAcpSessionMeta
} from './session-scanner-cursor-acp-meta'
import { discoverFiles } from '../../discovery/session-scanner-discovery'
import { createAccumulator, finalizeSession } from '../../parsing/session-scanner-accumulator'
import { scopeWalksAgentFiles } from '../../scope/session-scope-cwd'
import type {
  AiVaultScanOptions,
  FileWithMtime,
  SessionFileDiscovery
} from '../../session-scanner-types'

// `cursor-agent acp` keeps each chat in <config dir>/acp-sessions/<sessionId>/: meta.json (cwd,
// title) and store.db (the conversation). History lists a chat by store.db, whose mtime is its
// last activity as Cursor's own session/list reports it, and reads only the sibling meta.json.
const ACP_SESSIONS_DIR = 'acp-sessions'

/** Only sessions an Orca chat owns: Cursor's terminal cannot resume the rest, nor History read them. */
export function cursorAcpDiscoveries(
  options: AiVaultScanOptions,
  wslHomeDirs: readonly string[],
  limit: number,
  issues: AiVaultScanIssue[]
): Promise<SessionFileDiscovery>[] {
  const owned = options.cursorAcpSessions
  if (!owned || owned.sessionIds.length === 0) {
    return []
  }
  const sessionIds = new Set(owned.sessionIds)
  const rootDirs = new Set([
    ...owned.configDirs.map((configDir) => join(configDir, ACP_SESSIONS_DIR)),
    ...(owned.inWsl ? wslHomeDirs.map((home) => join(home, '.cursor', ACP_SESSIONS_DIR)) : [])
  ])
  return [...rootDirs].map((rootDir) =>
    discoverFiles({
      rootDir,
      limit,
      agent: 'cursor',
      issues,
      extensions: ['.db'],
      filePredicate: isCursorAcpSessionStorePath,
      // A rename rewrites only meta.json.
      contentDependencyPath: cursorAcpSessionMetaPath,
      directoryPredicate: (name, depth) => depth === 0 && sessionIds.has(name),
      keepScopeFiles: scopeWalksAgentFiles('cursor', options.scopePaths),
      statCache: options.statCache,
      signal: options.signal
    })
  )
}

/** A listing row only: the owning chat opens the conversation. */
export async function parseCursorAcpSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform,
  signal?: AbortSignal
): Promise<AiVaultSession | null> {
  const meta = await readCursorAcpSessionMeta(file.path, signal)
  if (!meta) {
    return null
  }
  const accumulator = createAccumulator({
    agent: 'cursor',
    file,
    sessionId: basename(dirname(file.path))
  })
  accumulator.cwd = meta.cwd
  accumulator.title = meta.title
  const session = finalizeSession(accumulator, platform)
  // `cursor-agent --resume` reads the terminal store and cannot open an ACP session.
  return session && { ...session, resumeCommand: '' }
}
