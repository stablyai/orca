import { extname } from 'node:path'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import { joinRemotePath } from '../ssh/ssh-remote-platform'
import { isMissingRemoteSessionPathError, statRemoteSessionFile } from './remote-session-file-stat'
import { partitionSubagentTranscriptPaths } from './session-scanner-subagent-transcripts'
import type { FileWithMtime } from './session-scanner-types'
import { errorMessage } from './session-scanner-values'
import type {
  RemoteScannerContext,
  RemoteSessionCandidate,
  RemoteSessionSource
} from './remote-session-scanner-types'

const REMOTE_DISCOVERY_CONCURRENCY = 8

export async function discoverRemoteSourceCandidates(args: {
  source: RemoteSessionSource
  context: RemoteScannerContext
  issues: AiVaultScanIssue[]
}): Promise<RemoteSessionCandidate[]> {
  const walked = args.source.fixedChildFileSegments
    ? await listRemoteFixedChildFiles(args.source, args.context, args.issues)
    : await walkRemoteSessionFiles(args.source, args.context, args.issues)
  const partition = args.source.collectSubagentSiblingCounts
    ? partitionSubagentTranscriptPaths(walked)
    : null
  const paths = partition ? partition.sessionFilePaths : walked
  const files = await mapDiscoveryConcurrently(paths, (path) =>
    statRemoteSessionFile(
      args.context.provider,
      path,
      args.source.agent,
      args.context.executionHostId,
      args.issues,
      { missingIsExpected: Boolean(args.source.fixedChildFileSegments) }
    )
  )
  return files
    .filter((file): file is FileWithMtime => Boolean(file))
    .map((file) => ({
      source: args.source,
      file,
      subagentTranscriptCount: partition?.subagentTranscriptCounts.get(file.path) ?? 0
    }))
}

async function listRemoteFixedChildFiles(
  source: RemoteSessionSource,
  context: RemoteScannerContext,
  issues: AiVaultScanIssue[]
): Promise<string[]> {
  let entries
  try {
    entries = await context.provider.readDir(source.rootDir)
  } catch (err) {
    recordRemoteDirectoryIssue(source, context.executionHostId, issues, source.rootDir, err)
    return []
  }
  const segments = source.fixedChildFileSegments ?? []
  // Why: Antigravity's transcript path is fixed. Constructing it avoids three
  // serialized SSH readDir round trips for every conversation directory.
  return entries
    .filter((entry) => entry.isDirectory && !entry.isSymlink)
    .map((entry) => joinRemotePath(context.hostPlatform, source.rootDir, entry.name, ...segments))
    .filter((path) => source.filePredicate?.(path) ?? true)
}

async function walkRemoteSessionFiles(
  source: RemoteSessionSource,
  context: RemoteScannerContext,
  issues: AiVaultScanIssue[],
  dirPath = source.rootDir,
  depth = 0
): Promise<string[]> {
  let entries
  try {
    entries = await context.provider.readDir(dirPath)
  } catch (err) {
    recordRemoteDirectoryIssue(source, context.executionHostId, issues, dirPath, err)
    return []
  }

  const extensions = new Set(source.extensions)
  const files: string[] = []
  for (const entry of entries) {
    const fullPath = joinRemotePath(context.hostPlatform, dirPath, entry.name)
    if (
      entry.isDirectory &&
      !entry.isSymlink &&
      (source.directoryPredicate?.(entry.name, depth) ?? true)
    ) {
      files.push(...(await walkRemoteSessionFiles(source, context, issues, fullPath, depth + 1)))
      continue
    }
    if (
      !entry.isSymlink &&
      extensions.has(extname(entry.name).toLowerCase()) &&
      (source.filePredicate?.(fullPath) ?? true)
    ) {
      files.push(fullPath)
    }
  }
  return files
}

function recordRemoteDirectoryIssue(
  source: RemoteSessionSource,
  executionHostId: ExecutionHostId,
  issues: AiVaultScanIssue[],
  path: string,
  err: unknown
): void {
  if (!isMissingRemoteSessionPathError(err)) {
    issues.push({ executionHostId, agent: source.agent, path, message: errorMessage(err) })
  }
}

async function mapDiscoveryConcurrently<T, U>(
  items: readonly T[],
  mapper: (item: T) => Promise<U>
): Promise<U[]> {
  const results: U[] = []
  for (let index = 0; index < items.length; index += REMOTE_DISCOVERY_CONCURRENCY) {
    const batch = items.slice(index, index + REMOTE_DISCOVERY_CONCURRENCY)
    results.push(...(await Promise.all(batch.map(mapper))))
  }
  return results
}
