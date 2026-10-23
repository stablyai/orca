import { basename, dirname, join } from 'node:path'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import { throwIfSignalAborted } from '../../shared/abort-signal-reason'
import { mapWithConcurrency } from '../../shared/map-with-concurrency'
import { wslGatedAccess } from '../native-chat/wsl-transcript-fs-access'
import { discoverFiles } from './session-scanner-discovery'
import { hermesHostHomes, hermesStoreHomes } from './session-scanner-hermes-stores'
import { listHermesSqliteSessionsViaWorker } from './session-scanner-hermes-worker'
import { SessionNewestFiles } from './session-newest-files'
import { scopeWalksAgentFiles } from './session-scope-cwd'
import type {
  AiVaultScanOptions,
  FileWithMtime,
  SessionFileDiscovery
} from './session-scanner-types'

function legacyId(file: FileWithMtime): string {
  return basename(file.path, '.json').slice('session_'.length)
}

async function scanStore(
  home: string,
  dbPath: string | undefined,
  sessionsDir: string,
  options: AiVaultScanOptions,
  limit: number,
  issues: AiVaultScanIssue[]
): Promise<SessionFileDiscovery> {
  const legacy = await discoverFiles({
    rootDir: sessionsDir,
    limit,
    agent: 'hermes',
    issues,
    extensions: ['.json'],
    filePredicate: (path) => basename(path).startsWith('session_'),
    keepScopeFiles: scopeWalksAgentFiles('hermes', options.scopePaths),
    signal: options.signal
  })
  if (!dbPath) {
    return legacy
  }
  try {
    await wslGatedAccess(dbPath, 'scan', options.signal)
  } catch (error) {
    throwIfSignalAborted(options.signal)
    if (
      !(
        error instanceof Error &&
        'code' in error &&
        (error.code === 'ENOENT' || error.code === 'ENOTDIR')
      )
    ) {
      issues.push({
        agent: 'hermes',
        kind: 'scope',
        path: dbPath,
        message: error instanceof Error ? error.message : String(error)
      })
    }
    return legacy
  }
  const represented = new Set<string>()
  const candidates = await listHermesSqliteSessionsViaWorker({
    dbPaths: [dbPath],
    limit,
    issues,
    signal: options.signal,
    legacySessionIds: [...new Set([...legacy.files, ...(legacy.scopeFiles ?? [])].map(legacyId))],
    onRepresentedSessionIds: (ids) => ids.forEach((id) => represented.add(id))
  })
  const scoped = scopeWalksAgentFiles('hermes', options.scopePaths)
    ? await listHermesSqliteSessionsViaWorker({
        dbPaths: [dbPath],
        limit,
        issues,
        signal: options.signal,
        scopePaths: options.scopePaths
      })
    : undefined
  return {
    agent: 'hermes',
    rootDir: home,
    files: [
      ...legacy.files.filter((file) => !represented.has(legacyId(file))),
      ...candidates.map((candidate) => candidate.file)
    ],
    ...(scoped
      ? {
          scopeFiles: [
            ...(legacy.scopeFiles ?? []).filter((file) => !represented.has(legacyId(file))),
            ...scoped.map((candidate) => candidate.file)
          ]
        }
      : {})
  }
}

export function hermesDiscoveries(
  options: AiVaultScanOptions,
  wslHomeDirs: readonly string[],
  limit: number,
  issues: AiVaultScanIssue[]
): Promise<SessionFileDiscovery>[] {
  return [
    (async () => {
      const storeHomes = await hermesStoreHomes(options, wslHomeDirs, issues)
      const homes = [...new Set([...hermesHostHomes(options, wslHomeDirs), ...storeHomes])]
      const databases = options.hermesStateDbPaths
        ? new Map(options.hermesStateDbPaths.map((path) => [dirname(path), path]))
        : new Map(storeHomes.map((home) => [home, join(home, 'state.db')]))
      const stores = await mapWithConcurrency(homes, 4, (home) =>
        scanStore(
          home,
          databases.get(home),
          options.hermesSessionsDir && dirname(options.hermesSessionsDir) === home
            ? options.hermesSessionsDir
            : join(home, 'sessions'),
          options,
          limit,
          issues
        )
      )
      const newest = new SessionNewestFiles(limit)
      const scopeFiles = scopeWalksAgentFiles('hermes', options.scopePaths)
        ? stores.flatMap((store) => store.scopeFiles ?? [])
        : undefined
      for (const store of stores) {
        for (const file of store.files) {
          const overflow = newest.add(file)
          if (overflow) {
            scopeFiles?.push(overflow)
          }
        }
      }
      return {
        agent: 'hermes' as const,
        rootDir: homes[0] ?? '',
        files: newest.newest(),
        ...(scopeFiles ? { scopeFiles } : {})
      }
    })()
  ]
}
