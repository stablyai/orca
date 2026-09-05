import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import type { AiVaultListResult } from '../shared/ai-vault-types'
import { resolveMimocodeDirectories } from '../main/mimo/mimocode-directories'
import { listOpenCodeSqliteSessions } from '../main/ai-vault/session-scanner-opencode-sqlite-list'
import { parseOpenCodeSqliteSession } from '../main/ai-vault/session-scanner-opencode-sqlite'
import { splitOpenCodeSqliteCandidate } from '../main/ai-vault/session-scanner-opencode-sqlite-paths'
import { openCodeDatabaseScanIssue } from '../main/ai-vault/session-scanner-opencode-sqlite-open'
import { throwIfAiVaultScanCancelled } from '../main/ai-vault/ai-vault-scan-cancellation'

// The relay's isolated scan child owns these reads, including the live WAL.
export async function scanRelayMimoSessions(args: {
  remoteHome: string
  limit: number
  signal?: AbortSignal
}): Promise<AiVaultListResult> {
  throwIfAiVaultScanCancelled(args.signal)
  const directories = resolveMimocodeDirectories(process.env.MIMOCODE_HOME?.trim(), {
    HOME: args.remoteHome
  })
  const dbPath = join(directories.data, 'mimocode.db')
  const result: AiVaultListResult = {
    sessions: [],
    issues: [],
    scannedAt: new Date().toISOString()
  }
  try {
    await stat(dbPath)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return result
    }
    result.issues.push(openCodeDatabaseScanIssue(dbPath, error, 'mimo-code'))
    return result
  }
  throwIfAiVaultScanCancelled(args.signal)
  const candidates = await listOpenCodeSqliteSessions({
    dbPaths: [dbPath],
    limit: args.limit,
    issues: result.issues,
    agent: 'mimo-code'
  })
  for (const candidate of candidates) {
    throwIfAiVaultScanCancelled(args.signal)
    const identity = splitOpenCodeSqliteCandidate(candidate.file.path)
    if (!identity) {
      throw new Error(`Invalid MiMo SQLite candidate: ${candidate.file.path}`)
    }
    try {
      const session = await parseOpenCodeSqliteSession({
        ...identity,
        platform: process.platform,
        agent: 'mimo-code'
      })
      if (session) {
        result.sessions.push(session)
      }
    } catch (error) {
      result.issues.push(openCodeDatabaseScanIssue(dbPath, error, 'mimo-code'))
      break
    }
    await yieldToEventLoop()
  }
  throwIfAiVaultScanCancelled(args.signal)
  return result
}
