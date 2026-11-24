import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AiVaultScanIssue } from '../../../../shared/ai-vault/contracts/ai-vault-types'
import { resolveAbsoluteDirOverride } from '../../../../shared/file-access/absolute-dir-override'
import type { AiVaultScanOptions, SessionFileDiscovery } from '../../session-scanner-types'
import { discoverStandaloneSqliteSessions } from '../opencode/sqlite/session-scanner-opencode-sqlite-discovery'

export function defaultDevinCliDirectory(): string {
  const home = homedir()
  const dataHome =
    process.platform === 'win32'
      ? resolveAbsoluteDirOverride(process.env.APPDATA, join(home, 'AppData', 'Roaming'))
      : resolveAbsoluteDirOverride(process.env.XDG_DATA_HOME, join(home, '.local', 'share'))
  return resolveAbsoluteDirOverride(process.env.DEVIN_HOME, join(dataHome, 'devin', 'cli'))
}

export function devinDatabaseDiscoveries(
  options: AiVaultScanOptions,
  wslHomeDirs: readonly string[],
  limit: number,
  issues: AiVaultScanIssue[]
): Promise<SessionFileDiscovery>[] {
  const cliDirectories = [
    options.devinTranscriptsDir ? dirname(options.devinTranscriptsDir) : defaultDevinCliDirectory(),
    ...(options.devinAccountCliDirs ?? []),
    ...wslHomeDirs.map((home) => join(home, '.local', 'share', 'devin', 'cli'))
  ]
  return [...new Set(cliDirectories)].map((dir) =>
    discoverStandaloneSqliteSessions('devin', join(dir, 'sessions.db'), options, limit, issues)
  )
}
