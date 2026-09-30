import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import { isOpenCodeV2DatabaseName } from '../../shared/opencode-database-name'
import { joinRemotePath } from '../ssh/ssh-remote-platform'
import { throwIfAiVaultScanCancelled } from './ai-vault-scan-cancellation'
import { isMissingRemoteSessionPathError } from './remote-session-file-stat'
import { discoverRemoteSourceCandidates } from './remote-session-scanner-discovery'
import { remotePathSegments } from './remote-session-scanner-source-parsers'
import type {
  RemoteOpenCodeSessionReader,
  RemoteScannerContext,
  RemoteSessionSource
} from './remote-session-scanner-types'
import { recordSessionScanIssue } from './session-scan-issues'
import { restampAiVaultListResult } from './session-list-results'
import { splitOpenCodeSqliteCandidate } from './session-scanner-opencode-sqlite-paths'
import { errorMessage } from './session-scanner-values'

export function remoteOpenCodeSources(
  reader: RemoteOpenCodeSessionReader | undefined,
  candidateLimit: number
): RemoteSessionSource[] {
  if (!reader) {
    return []
  }
  let databasePaths: Promise<string[]> | undefined
  return (['opencode', 'opencode2'] as const).map((agent) => {
    const source: RemoteSessionSource = {
      agent,
      rootDir: reader.dataDirectory,
      extensions: ['.json'],
      parse: async () => null,
      parseCandidate: async (file, context) => {
        throwIfAiVaultScanCancelled(context.signal)
        const candidate = splitOpenCodeSqliteCandidate(file.path)
        const session = candidate
          ? await reader.parse({
              ...candidate,
              platform: context.hostPlatform.os,
              ...(agent === 'opencode2' ? { agent } : {}),
              signal: context.signal
            })
          : await reader.parseLegacy(file, context.hostPlatform.os)
        throwIfAiVaultScanCancelled(context.signal)
        if (!session) {
          return null
        }
        const stamped = restampAiVaultListResult(
          { sessions: [session], issues: [], scannedAt: '' },
          context.executionHostId
        ).sessions[0]
        return stamped ? { ...stamped, executionHostPlatform: context.hostPlatform.os } : null
      },
      discover: async (context, issues) => {
        databasePaths ??= discoverDatabasePaths(reader, context, issues)
        const paths = await databasePaths
        const ownPaths =
          agent === 'opencode2'
            ? paths
            : paths.filter(
                (path) => !isOpenCodeV2DatabaseName(remotePathSegments(path).at(-1) ?? '')
              )
        const readIssues: AiVaultScanIssue[] = []
        const candidates = await reader.list({
          dbPaths: ownPaths,
          limit: candidateLimit,
          issues: readIssues,
          ...(agent === 'opencode2' ? { agent } : {}),
          signal: context.signal
        })
        throwIfAiVaultScanCancelled(context.signal)
        for (const issue of readIssues) {
          recordSessionScanIssue(issues, { ...issue, executionHostId: context.executionHostId })
        }
        const files = candidates.map((candidate) => candidate.file)
        if (agent === 'opencode2') {
          return files
        }
        const legacy = await discoverRemoteSourceCandidates({
          source: {
            ...source,
            discover: undefined,
            rootDir: joinRemotePath(
              context.hostPlatform,
              reader.dataDirectory,
              'storage',
              'session'
            )
          },
          context,
          issues
        })
        const ids = new Set(files.map((file) => splitOpenCodeSqliteCandidate(file.path)?.sessionId))
        return [
          ...files,
          ...legacy
            .filter(
              ({ file }) =>
                !ids.has(
                  remotePathSegments(file.path)
                    .at(-1)
                    ?.replace(/\.json$/, '')
                )
            )
            .map(({ file }) => file)
        ]
      }
    }
    return source
  })
}

async function discoverDatabasePaths(
  reader: RemoteOpenCodeSessionReader,
  context: RemoteScannerContext,
  issues: AiVaultScanIssue[]
): Promise<string[]> {
  throwIfAiVaultScanCancelled(context.signal)
  if (reader.databasePath === null) {
    return []
  }
  try {
    if (reader.databasePath !== undefined) {
      const stat = await context.provider.stat(reader.databasePath)
      return stat.type === 'file' || stat.type === 'symlink' ? [reader.databasePath] : []
    }
    const entries = await context.provider.readDir(reader.dataDirectory)
    return entries
      .filter(
        (entry) =>
          !entry.isDirectory &&
          !entry.isSymlink &&
          /^opencode(?:-[A-Za-z0-9_.-]+)?\.db$/.test(entry.name)
      )
      .map((entry) => joinRemotePath(context.hostPlatform, reader.dataDirectory, entry.name))
      .sort()
  } catch (error) {
    throwIfAiVaultScanCancelled(context.signal)
    if (!isMissingRemoteSessionPathError(error)) {
      recordSessionScanIssue(issues, {
        executionHostId: context.executionHostId,
        agent: 'opencode',
        kind: 'scope',
        path: reader.databasePath ?? reader.dataDirectory,
        message: errorMessage(error)
      })
    }
    return []
  }
}
