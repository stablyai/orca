import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import {
  CURSOR_SIDECAR_MAX_AGGREGATE_BYTES,
  CURSOR_SIDECAR_MAX_BUCKETS,
  CURSOR_SIDECAR_MAX_BYTES,
  CURSOR_SIDECAR_MAX_SCOPE_PATHS,
  CURSOR_SIDECAR_MAX_SESSION_DIRS,
  type CursorSidecarScanState
} from '../../shared/cursor-sidecar-scan'
import {
  cursorSidecarScanCancellationFromSignal,
  discoverCursorSidecarCandidates,
  type CursorSidecarScanCaps
} from '../../shared/cursor-sidecar-scan-discovery'
import type { CursorCwdEvidence, FileWithMtime } from './session-scanner-types'
import {
  wslGatedLstat,
  wslGatedOpendir,
  wslGatedRealpath
} from '../native-chat/wsl-transcript-fs-access'

export type LocalCursorSidecarDiscovery = {
  rootRealPath: string | null
  files: FileWithMtime[]
  evidenceByPath: Map<string, CursorCwdEvidence>
  counters: CursorSidecarScanState['counters']
  truncated: CursorSidecarScanState['truncated']
}

const LOCAL_CAPS: CursorSidecarScanCaps = {
  buckets: CURSOR_SIDECAR_MAX_BUCKETS,
  sessions: CURSOR_SIDECAR_MAX_SESSION_DIRS,
  scopes: CURSOR_SIDECAR_MAX_SCOPE_PATHS,
  sidecarBytes: CURSOR_SIDECAR_MAX_BYTES,
  aggregateBytes: CURSOR_SIDECAR_MAX_AGGREGATE_BYTES
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
    chatsRoot: args.chatsDir,
    scopePaths: args.scopePaths,
    caps: LOCAL_CAPS,
    response,
    cancellation: cursorSidecarScanCancellationFromSignal(args.signal),
    pathPlatform: args.pathPlatform,
    resolveScopePaths: args.resolveScopePaths,
    io: {
      lstat: (path) => wslGatedLstat(path, 'scan', args.signal),
      opendir: (path) => wslGatedOpendir(path, 'scan', args.signal),
      realpath: (path) => wslGatedRealpath(path, 'scan', args.signal)
    }
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

function emptyLocalScanResponse(): CursorSidecarScanState {
  return {
    issues: [],
    counters: {
      rootReaddir: 0,
      bucketReaddir: 0,
      direntsRead: 0,
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
