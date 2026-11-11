import {
  currentSessionDiscovery,
  discoverSessionContainer,
  discoverSessionContainerPaths
} from '../../session-discovery-context'
import { basename, dirname, join } from 'node:path'
import type { AiVaultScanIssue } from '../../../../shared/ai-vault/contracts/ai-vault-types'
import type { WslTranscriptFsError } from '../../../native-chat/wsl-transcript-fs-error'
import { resolveOpenCodeStorageDirectory } from '../../../opencode/opencode-data-directory'
import {
  listOpenCodeDatabases,
  listOpenCodeDatabasesInDirectory
} from '../../../opencode-usage/opencode-database-discovery'
import { recordSessionScanIssue, scanIssueTextFromError } from '../../session-scan-issues'
import { discoverOpenCodeSessions } from './sqlite/session-scanner-opencode-sqlite-discovery'
import { listOpenCode2SqliteSessionsViaWorker } from './reader-transport/session-scanner-opencode-sqlite-worker-spawn'
import { isOpenCodeV2DatabaseName } from '../../../../shared/opencode-database-name'
import type { AiVaultScanOptions, SessionFileDiscovery } from '../../session-scanner-types'
import { isMissingTranscriptPathError } from '../../session-scanner-discovery'
import { scopeWalksAgentFiles } from '../../session-scope-cwd'

type OpenCodeSource = {
  storageDir: string
  dbPaths: (issues: AiVaultScanIssue[]) => Promise<readonly string[]>
}

export function opencodeDiscoveries(
  options: AiVaultScanOptions,
  wslHomeDirs: readonly string[],
  limit: number,
  issues: AiVaultScanIssue[]
): Promise<SessionFileDiscovery>[] {
  return opencodeSources(options, wslHomeDirs).flatMap((source) => {
    const { storageDir } = source
    const paths = discoverSessionContainerPaths(storageDir, source.dbPaths, issues)
    return [
      paths.then(({ paths: dbPaths, complete }) =>
        discoverOpenCodeSessions({
          storageDir,
          enumerationComplete: complete,
          dbPaths: dbPaths.filter((path) => !isOpenCodeV2DatabaseName(basename(path))),
          limitPerAgent: limit,
          issues,
          scopePaths: options.scopePaths,
          signal: options.signal
        })
      ),
      // Current releases share opencode.db with v1; the worker checks for v2 tables.
      paths.then(({ paths: dbPaths, complete }) =>
        discoverOpenCode2Sessions(storageDir, dbPaths, limit, issues, options, complete)
      )
    ]
  })
}

function opencodeSources(
  options: AiVaultScanOptions,
  wslHomeDirs: readonly string[]
): OpenCodeSource[] {
  const listDirectory = (directory: string | undefined, targetIssues: AiVaultScanIssue[]) => {
    const onRefusal = (path: string, error: WslTranscriptFsError): void => {
      recordSessionScanIssue(targetIssues, {
        agent: 'opencode',
        path,
        ...scanIssueTextFromError(error)
      })
    }
    const onFsError = (path: string, error: unknown): void => {
      if (currentSessionDiscovery() && !isMissingTranscriptPathError(error)) {
        recordSessionScanIssue(targetIssues, {
          agent: 'opencode',
          path,
          ...scanIssueTextFromError(error)
        })
      }
    }
    return directory
      ? listOpenCodeDatabasesInDirectory(directory, onRefusal, options.signal, onFsError)
      : listOpenCodeDatabases(onRefusal, onFsError, options.signal)
  }
  const dataDirectorySource = (dataDirectory: string): OpenCodeSource => ({
    storageDir: join(dataDirectory, 'storage'),
    dbPaths: async (targetIssues) =>
      options.opencodeDbPaths ? [] : listDirectory(dataDirectory, targetIssues)
  })
  const storageDir = options.opencodeStorageDir ?? resolveOpenCodeStorageDirectory()
  const primary: OpenCodeSource = {
    storageDir,
    dbPaths: async (targetIssues) => {
      if (options.opencodeDbPaths) {
        return options.opencodeDbPaths
      }
      // Custom storage roots still place SQLite databases in the parent data directory.
      return options.opencodeStorageDir
        ? listDirectory(dirname(storageDir), targetIssues)
        : listDirectory(undefined, targetIssues)
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
  options: AiVaultScanOptions,
  enumerationComplete = true
): Promise<SessionFileDiscovery> {
  const list = (
    scopePaths?: readonly string[],
    paths = dbPaths,
    count = limit,
    requestIssues = issues
  ) =>
    listOpenCode2SqliteSessionsViaWorker({
      dbPaths: paths,
      limit: count,
      issues: requestIssues,
      scopePaths,
      signal: options.signal
    }).then((candidates) => candidates.map((candidate) => candidate.file))
  const [discovery, scopeFiles] = await Promise.all([
    discoverSessionContainer(
      `opencode2:${storageDir}`,
      dbPaths,
      async (paths, count) => {
        const requestIssues: AiVaultScanIssue[] = []
        const files = await list(undefined, paths, count, requestIssues)
        issues.push(...requestIssues)
        return {
          agent: 'opencode2',
          rootDir: storageDir,
          files,
          complete: !requestIssues.some((issue) => issue.kind !== 'notice')
        }
      },
      limit,
      issues,
      enumerationComplete
    ),
    scopeWalksAgentFiles('opencode2', options.scopePaths) ? list(options.scopePaths) : undefined
  ])
  return {
    agent: 'opencode2' as const,
    sourceOrder: discovery.sourceOrder,
    rootDir: storageDir,
    files: discovery.files,
    ...(scopeFiles ? { scopeFiles } : {})
  }
}
