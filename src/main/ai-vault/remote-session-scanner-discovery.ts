import { extname } from 'node:path'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import { joinRemotePath } from '../ssh/ssh-remote-platform'
import { isMissingRemoteSessionPathError, statRemoteSessionFile } from './remote-session-file-stat'
import type { FileWithMtime } from './session-scanner-types'
import { errorMessage } from './session-scanner-values'
import { mapRemoteScanBatches } from './remote-session-scan-batching'
import { throwIfAiVaultScanCancelled } from './ai-vault-scan-cancellation'
import { recordSessionScanIssue } from './session-scan-issues'
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
  const partition = args.source.partitionSubagentTranscripts?.(walked) ?? null
  const paths = partition ? partition.sessionFilePaths : walked
  const files = await mapRemoteScanBatches(
    paths,
    REMOTE_DISCOVERY_CONCURRENCY,
    (path) => statRemoteCandidateFile(path, args.source, args.context, args.issues),
    args.context.signal
  )
  return files
    .filter((file): file is FileWithMtime => Boolean(file))
    .map((file) => ({
      source: args.source,
      file,
      subagentTranscriptCount: partition?.subagentTranscriptCounts.get(file.path) ?? 0
    }))
}

async function statRemoteCandidateFile(
  path: string,
  source: RemoteSessionSource,
  context: RemoteScannerContext,
  issues: AiVaultScanIssue[]
): Promise<FileWithMtime | null> {
  const file = await statRemoteSessionFile(
    context.provider,
    path,
    source.agent,
    context.executionHostId,
    issues,
    {
      missingIsExpected: Boolean(source.fixedChildFileSegments),
      signal: context.signal
    }
  )
  if (!file || !source.contentDependencyPath) {
    return file
  }
  const dependency = await statRemoteSessionFile(
    context.provider,
    source.contentDependencyPath(path),
    source.agent,
    context.executionHostId,
    issues,
    { missingIsExpected: true, signal: context.signal }
  )
  if (!dependency) {
    return file
  }
  const mtimeMs = Math.max(file.mtimeMs, dependency.mtimeMs)
  return {
    ...file,
    mtimeMs,
    modifiedAt: new Date(mtimeMs).toISOString(),
    sizeBytes: (file.sizeBytes ?? 0) + (dependency.sizeBytes ?? 0)
  }
}

async function listRemoteFixedChildFiles(
  source: RemoteSessionSource,
  context: RemoteScannerContext,
  issues: AiVaultScanIssue[]
): Promise<string[]> {
  throwIfAiVaultScanCancelled(context.signal)
  let entries
  try {
    entries = await context.provider.readDir(source.rootDir)
  } catch (err) {
    throwIfAiVaultScanCancelled(context.signal)
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
  throwIfAiVaultScanCancelled(context.signal)
  let entries
  try {
    entries = await context.provider.readDir(dirPath)
  } catch (err) {
    throwIfAiVaultScanCancelled(context.signal)
    recordRemoteDirectoryIssue(source, context.executionHostId, issues, dirPath, err)
    return []
  }

  const extensions = new Set(source.extensions)
  const files: string[] = []
  for (const entry of entries) {
    throwIfAiVaultScanCancelled(context.signal)
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
    recordSessionScanIssue(issues, {
      executionHostId,
      agent: source.agent,
      kind: 'host',
      path,
      message: errorMessage(err)
    })
  }
}
