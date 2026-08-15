// Why: jcode session discovery lives outside session-scanner-source-discovery
// so that file stays under its max-lines budget (same split as the droid/kimi
// sources module). JCODE_HOME is honored so a redirected runtime still surfaces
// its sessions.
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import { discoverFiles } from './session-scanner-discovery'
import type { AiVaultScanOptions, SessionFileDiscovery } from './session-scanner-types'
import { sessionRootDirs } from './session-scanner-source-discovery'

export const JCODE_SESSIONS_DIR = join(
  process.env.JCODE_HOME?.trim() || join(homedir(), '.jcode'),
  'sessions'
)

export function jcodeDiscoveries(
  options: AiVaultScanOptions,
  wslHomeDirs: readonly string[],
  limit: number,
  issues: AiVaultScanIssue[]
): Promise<SessionFileDiscovery>[] {
  return sessionRootDirs(options.jcodeSessionsDir ?? JCODE_SESSIONS_DIR, wslHomeDirs, [
    '.jcode',
    'sessions'
  ]).map((rootDir) =>
    discoverFiles({
      rootDir,
      limit,
      agent: 'jcode',
      issues,
      extensions: ['.json'],
      // Why: skip the live .journal.jsonl appends and consolidated backups.
      filePredicate: (path) => basename(path).startsWith('session_')
    })
  )
}
