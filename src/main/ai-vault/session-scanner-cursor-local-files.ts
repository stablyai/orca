import { lstat, realpath } from 'node:fs/promises'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import {
  CURSOR_REMOTE_MAX_AGGREGATE_BYTES,
  CURSOR_REMOTE_MAX_BUCKETS,
  CURSOR_REMOTE_MAX_SCOPE_PATHS,
  CURSOR_REMOTE_MAX_SESSION_DIRS,
  CURSOR_SIDECAR_MAX_BYTES,
  CURSOR_SIDECAR_SCAN_VERSION,
  type CursorSidecarScanResponse
} from '../../shared/cursor-sidecar-scan'
import {
  cursorSidecarScanCancellationFromSignal,
  discoverCursorSidecarCandidates,
  type CursorSidecarScanCaps
} from '../../shared/cursor-sidecar-scan-discovery'
import type { CursorCwdEvidence, FileWithMtime } from './session-scanner-types'
import { errorMessage } from './session-scanner-values'
import { cursorSessionStorePath } from './session-scanner-cursor-paths'

export type LocalCursorSidecarDiscovery = {
  rootRealPath: string | null
  files: FileWithMtime[]
  evidenceByPath: Map<string, CursorCwdEvidence>
  counters: CursorSidecarScanResponse['counters']
  truncated: CursorSidecarScanResponse['truncated']
}

const LOCAL_CAPS: CursorSidecarScanCaps = {
  buckets: CURSOR_REMOTE_MAX_BUCKETS,
  sessions: CURSOR_REMOTE_MAX_SESSION_DIRS,
  scopes: CURSOR_REMOTE_MAX_SCOPE_PATHS,
  sidecarBytes: CURSOR_SIDECAR_MAX_BYTES,
  aggregateBytes: CURSOR_REMOTE_MAX_AGGREGATE_BYTES
}

export async function discoverLocalCursorSidecarsBounded(args: {
  chatsDir: string
  scopePaths: readonly string[]
  issues: AiVaultScanIssue[]
  signal?: AbortSignal
  pathPlatform?: NodeJS.Platform
  resolveScopePaths?: (scopePath: string) => Promise<readonly string[]>
}): Promise<LocalCursorSidecarDiscovery> {
  const response = emptyLocalScanResponse()
  // Pass the full scope list so discovery can mark truncation before capping.
  const discovery = await discoverCursorSidecarCandidates({
    request: {
      version: CURSOR_SIDECAR_SCAN_VERSION,
      chatsRoot: args.chatsDir,
      scopePaths: [...args.scopePaths],
      maxBuckets: LOCAL_CAPS.buckets,
      maxSessionDirs: LOCAL_CAPS.sessions,
      maxScopePaths: LOCAL_CAPS.scopes,
      maxSidecarBytes: LOCAL_CAPS.sidecarBytes,
      maxAggregateBytes: LOCAL_CAPS.aggregateBytes
    },
    caps: LOCAL_CAPS,
    response,
    cancellation: cursorSidecarScanCancellationFromSignal(args.signal),
    pathPlatform: args.pathPlatform,
    resolveScopePaths: args.resolveScopePaths
  })

  for (const issue of response.issues) {
    args.issues.push({ agent: 'cursor', path: issue.path, message: issue.message })
  }
  if (response.truncated.scopePaths) {
    pushTruncationIssue(args.issues, 'scope paths')
  }
  if (response.truncated.buckets) {
    pushTruncationIssue(args.issues, 'buckets')
  }
  if (response.truncated.sessionDirs) {
    pushTruncationIssue(args.issues, 'session directories')
  }
  if (response.truncated.sidecarBytes) {
    pushTruncationIssue(args.issues, 'sidecar bytes')
  }

  if (!discovery) {
    return {
      rootRealPath: null,
      files: [],
      evidenceByPath: new Map(),
      counters: response.counters,
      truncated: response.truncated
    }
  }

  const evidenceByPath = new Map<string, CursorCwdEvidence>()
  const files: FileWithMtime[] = discovery.candidates.map((candidate) => {
    if (candidate.scopeCwd) {
      evidenceByPath.set(candidate.metaPath, {
        kind: 'scope-bucket',
        cwd: candidate.scopeCwd,
        bucket: candidate.name
      })
    }
    return {
      path: candidate.metaPath,
      mtimeMs: candidate.meta.mtimeMs,
      modifiedAt: safeDateIso(candidate.meta.mtimeMs),
      sizeBytes: candidate.meta.size,
      dev: candidate.meta.dev,
      ino: candidate.meta.ino,
      nlink: candidate.meta.nlink,
      cursorStoreMtimeMs: candidate.store.mtimeMs
    }
  })

  return {
    rootRealPath: discovery.rootRealPath,
    files,
    evidenceByPath,
    counters: response.counters,
    truncated: response.truncated
  }
}

export async function localCursorRootRealPath(
  chatsDir: string,
  issues: AiVaultScanIssue[]
): Promise<string | null> {
  try {
    return await realpath(chatsDir)
  } catch (error) {
    if (!isMissingCursorPathError(error)) {
      issues.push({ agent: 'cursor', path: chatsDir, message: errorMessage(error) })
    }
    return null
  }
}

export async function cursorLocalFileMetadata(filePath: string): Promise<FileWithMtime | null> {
  try {
    const fileStat = await lstat(filePath)
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
      return null
    }
    return {
      path: filePath,
      mtimeMs: fileStat.mtimeMs,
      modifiedAt: fileStat.mtime.toISOString(),
      sizeBytes: fileStat.size,
      dev: fileStat.dev,
      ino: fileStat.ino,
      nlink: fileStat.nlink
    }
  } catch {
    return null
  }
}

export async function validateLocalCursorSidecars(
  files: readonly FileWithMtime[],
  issues: AiVaultScanIssue[]
): Promise<FileWithMtime[]> {
  const retained: FileWithMtime[] = []
  for (const file of files) {
    try {
      const [metaStat, storeStat] = await Promise.all([
        lstat(file.path),
        lstat(cursorSessionStorePath(file.path))
      ])
      if (
        !metaStat.isFile() ||
        metaStat.isSymbolicLink() ||
        !storeStat.isFile() ||
        storeStat.isSymbolicLink()
      ) {
        continue
      }
      if (metaStat.size > CURSOR_SIDECAR_MAX_BYTES) {
        issues.push({
          agent: 'cursor',
          path: file.path,
          message: 'Cursor session metadata exceeds the read limit.'
        })
        continue
      }
      retained.push({
        ...file,
        sizeBytes: metaStat.size,
        cursorStoreMtimeMs: storeStat.mtimeMs
      })
    } catch (error) {
      if (!isMissingCursorPathError(error)) {
        issues.push({ agent: 'cursor', path: file.path, message: errorMessage(error) })
      }
    }
  }
  return retained
}

export function isMissingCursorPathError(error: unknown): boolean {
  const code =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : null
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function emptyLocalScanResponse(): CursorSidecarScanResponse {
  return {
    version: CURSOR_SIDECAR_SCAN_VERSION,
    scopeCwds: [],
    sidecars: [],
    issues: [],
    counters: {
      rootReaddir: 0,
      bucketReaddir: 0,
      fileLstat: 0,
      boundedReads: 0,
      scopeRealpath: 0,
      returnedBytes: 0,
      elapsedMs: 0
    },
    truncated: { scopePaths: false, buckets: false, sessionDirs: false, sidecarBytes: false }
  }
}

function pushTruncationIssue(issues: AiVaultScanIssue[], dimension: string): void {
  issues.push({
    agent: 'cursor',
    path: 'cursor sidecar scan',
    message: `Cursor sidecar scan truncated by the ${dimension} limit.`
  })
}

function safeDateIso(value: number): string {
  return Math.abs(value) <= 8_640_000_000_000_000
    ? new Date(value).toISOString()
    : new Date(0).toISOString()
}
