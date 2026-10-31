import { basename, dirname, join } from 'node:path'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import type { WslTranscriptFsError } from '../native-chat/wsl-transcript-fs-gate'
import { resolveOpenCodeStorageDirectory } from '../opencode/opencode-data-directory'
import {
  listOpenCodeDatabases,
  listOpenCodeDatabasesInDirectory
} from '../opencode-usage/opencode-database-discovery'
import { recordSessionScanIssue, scanIssueTextFromError } from './session-scan-issues'
import { discoverOpenCodeSessions } from './session-scanner-opencode-sqlite-discovery'
import { listOpenCode2SqliteSessionsViaWorker } from './session-scanner-opencode-sqlite-worker-spawn'
import { isOpenCodeV2DatabaseName } from '../../shared/opencode-database-name'
import type { AiVaultScanOptions, SessionFileDiscovery } from './session-scanner-types'
import { scopeWalksAgentFiles } from './session-scope-cwd'
import { isSelectedSessionFile } from './session-scanner-selection'

type OpenCodeSource = {
  storageDir: string
  dbPaths: () => Promise<readonly string[]>
}

export function opencodeDiscoveries(
  options: AiVaultScanOptions,
  wslHomeDirs: readonly string[],
  limit: number,
  issues: AiVaultScanIssue[]
): Promise<SessionFileDiscovery>[] {
  return opencodeSources(options, wslHomeDirs, issues).flatMap((source) => {
    const { storageDir } = source
    const paths = source.dbPaths()
    return [
      paths.then((dbPaths) =>
        discoverOpenCodeSessions({
          storageDir,
          dbPaths: dbPaths.filter((path) => !isOpenCodeV2DatabaseName(basename(path))),
          limitPerAgent: limit,
          issues,
          scopePaths: options.scopePaths,
          selectedSessionId: options.selectedSessionId,
          signal: options.signal
        })
      ),
      // Current releases share opencode.db with v1; the worker checks for v2 tables.
      paths.then((dbPaths) =>
        discoverOpenCode2Sessions(storageDir, dbPaths, limit, issues, options)
      )
    ]
  })
}

function opencodeSources(
  options: AiVaultScanOptions,
  wslHomeDirs: readonly string[],
  issues: AiVaultScanIssue[]
): OpenCodeSource[] {
  const onRefusal = (path: string, error: WslTranscriptFsError): void => {
    recordSessionScanIssue(issues, { agent: 'opencode', path, ...scanIssueTextFromError(error) })
  }
  const dataDirectorySource = (dataDirectory: string): OpenCodeSource => ({
    storageDir: join(dataDirectory, 'storage'),
    dbPaths: async () =>
      options.opencodeDbPaths
        ? []
        : listOpenCodeDatabasesInDirectory(dataDirectory, onRefusal, options.signal)
  })
  const storageDir = options.opencodeStorageDir ?? resolveOpenCodeStorageDirectory()
  const primary: OpenCodeSource = {
    storageDir,
    dbPaths: async () => {
      if (options.opencodeDbPaths) {
        return options.opencodeDbPaths
      }
      // Custom storage roots still place SQLite databases in the parent data directory.
      return options.opencodeStorageDir
        ? listOpenCodeDatabasesInDirectory(dirname(storageDir), onRefusal, options.signal)
        : listOpenCodeDatabases(onRefusal, undefined, options.signal)
    }
  }
  // Orca-managed accounts relocate XDG_DATA_HOME, so their stores are invisible to the default lookup.
  const accountDataDirs = (options.opencodeAccountDataDirs ?? []).filter(
    (dataDirectory) => dataDirectory !== dirname(storageDir)
  )
  return [
    primary,
    ...[...new Set(accountDataDirs)].map(dataDirectorySource),
    ...wslHomeDirs.map((homeDir) =>
      dataDirectorySource(join(homeDir, '.local', 'share', 'opencode'))
    )
  ]
}

async function discoverOpenCode2Sessions(
  storageDir: string,
  dbPaths: readonly string[],
  limit: number,
  issues: AiVaultScanIssue[],
  options: AiVaultScanOptions
): Promise<SessionFileDiscovery> {
  const list = (scopePaths?: readonly string[]) =>
    listOpenCode2SqliteSessionsViaWorker({
      dbPaths,
      limit,
      issues,
      scopePaths,
      selectedSessionId: options.selectedSessionId,
      signal: options.signal
    }).then((candidates) => candidates.map((candidate) => candidate.file))
  const [files, scopeFiles] = await Promise.all([
    list(),
    scopeWalksAgentFiles('opencode2', options.scopePaths) ? list(options.scopePaths) : undefined
  ])
  return {
    agent: 'opencode2' as const,
    rootDir: storageDir,
    files,
    selectedFiles: files.filter((file) =>
      isSelectedSessionFile(options.selectedSessionId, 'opencode2', file.path)
    ),
    ...(scopeFiles ? { scopeFiles } : {})
  }
}
