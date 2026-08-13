import type {
  CursorSidecarScanRequest,
  CursorSidecarScanResponse
} from '../shared/cursor-sidecar-scan'
import {
  CURSOR_REMOTE_MAX_AGGREGATE_BYTES,
  CURSOR_REMOTE_MAX_BUCKETS,
  CURSOR_REMOTE_MAX_SCOPE_PATHS,
  CURSOR_REMOTE_MAX_SESSION_DIRS,
  CURSOR_SIDECAR_MAX_BYTES,
  CURSOR_SIDECAR_SCAN_VERSION,
  cursorSidecarScanRequestSchema,
  cursorSidecarScanResponseSchema
} from '../shared/cursor-sidecar-scan'
import { readVerifiedBoundedTextFile } from '../shared/node-verified-bounded-text-file'
import type { RequestContext } from './dispatcher'
import {
  discoverCursorSidecarCandidates,
  isCursorSidecarScanCancelledError,
  type CursorSidecarScanCandidate,
  type CursorSidecarScanCaps,
  type CursorSidecarScanCancellation
} from '../shared/cursor-sidecar-scan-discovery'

export async function scanCursorSidecars(
  input: unknown,
  context: RequestContext
): Promise<CursorSidecarScanResponse> {
  const request = cursorSidecarScanRequestSchema.parse(input)
  const startedAt = Date.now()
  const caps = clampCaps(request)
  const response = emptyResponse()
  const discovery = await discoverCursorSidecarCandidates({
    request,
    caps,
    response,
    cancellation: cancellationFromContext(context)
  })
  if (!discovery) {
    return finish(response, startedAt)
  }
  await readCandidates(discovery.candidates, discovery.rootRealPath, caps, response, context)
  return finish(response, startedAt)
}

function clampCaps(request: CursorSidecarScanRequest): CursorSidecarScanCaps {
  return {
    buckets: Math.min(request.maxBuckets, CURSOR_REMOTE_MAX_BUCKETS),
    sessions: Math.min(request.maxSessionDirs, CURSOR_REMOTE_MAX_SESSION_DIRS),
    scopes: Math.min(request.maxScopePaths, CURSOR_REMOTE_MAX_SCOPE_PATHS),
    sidecarBytes: Math.min(request.maxSidecarBytes, CURSOR_SIDECAR_MAX_BYTES),
    aggregateBytes: Math.min(request.maxAggregateBytes, CURSOR_REMOTE_MAX_AGGREGATE_BYTES)
  }
}

async function readCandidates(
  candidates: readonly CursorSidecarScanCandidate[],
  rootRealPath: string,
  caps: CursorSidecarScanCaps,
  response: CursorSidecarScanResponse,
  context: RequestContext
): Promise<void> {
  let chargedBytes = 0
  for (let index = 0; index < candidates.length; index += 1) {
    throwIfCancelled(context)
    if (chargedBytes >= caps.aggregateBytes) {
      if (index < candidates.length) {
        response.truncated.sidecarBytes = true
      }
      break
    }
    const candidate = candidates[index]
    // Pre-check statted size so we do not open a sidecar that cannot fit.
    if (chargedBytes + candidate.meta.size > caps.aggregateBytes) {
      response.truncated.sidecarBytes = true
      break
    }
    try {
      response.counters.boundedReads++
      const content = await readVerifiedBoundedTextFile(candidate.metaPath, {
        expectedRootRealPath: rootRealPath,
        maxBytes: Math.min(caps.sidecarBytes, caps.aggregateBytes - chargedBytes)
      })
      throwIfCancelled(context)
      const bytes = Buffer.byteLength(content, 'utf8')
      chargedBytes += bytes
      if (chargedBytes > caps.aggregateBytes) {
        response.truncated.sidecarBytes = true
        break
      }
      response.counters.returnedBytes += bytes
      response.sidecars.push({
        bucket: candidate.name,
        sessionId: candidate.sessionId,
        metaPath: candidate.metaPath,
        content,
        metaMtimeMs: candidate.meta.mtimeMs,
        metaSizeBytes: candidate.meta.size,
        storeMtimeMs: candidate.store.mtimeMs,
        scopeCwd: candidate.scopeCwd
      })
      if (chargedBytes >= caps.aggregateBytes && index < candidates.length - 1) {
        response.truncated.sidecarBytes = true
        break
      }
    } catch (error) {
      throwIfCancelled(context)
      if (isCursorSidecarScanCancelledError(error)) {
        throw error
      }
      if (!isMissing(error)) {
        addIssue(response, candidate.metaPath, error)
      }
      // A failed remote read hides how many bytes it consumed; charge its full ceiling.
      chargedBytes = Math.min(caps.aggregateBytes, chargedBytes + caps.sidecarBytes)
      if (isVerifiedReadTooLargeError(error)) {
        response.truncated.sidecarBytes = true
        break
      }
      if (chargedBytes >= caps.aggregateBytes && index < candidates.length - 1) {
        response.truncated.sidecarBytes = true
        break
      }
    }
  }
}

function emptyResponse(): CursorSidecarScanResponse {
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

function finish(response: CursorSidecarScanResponse, startedAt: number): CursorSidecarScanResponse {
  response.counters.elapsedMs = Math.max(0, Date.now() - startedAt)
  if (response.truncated.scopePaths) {
    addAggregateIssue(response, 'scope paths')
  }
  if (response.truncated.buckets) {
    addAggregateIssue(response, 'buckets')
  }
  if (response.truncated.sessionDirs) {
    addAggregateIssue(response, 'session directories')
  }
  if (response.truncated.sidecarBytes) {
    addAggregateIssue(response, 'sidecar bytes')
  }
  return cursorSidecarScanResponseSchema.parse(response)
}

function addAggregateIssue(response: CursorSidecarScanResponse, dimension: string): void {
  response.issues.push({
    path: 'cursor sidecar scan',
    message: `Cursor sidecar scan truncated by the ${dimension} limit.`
  })
}

function addIssue(response: CursorSidecarScanResponse, path: string, error: unknown): void {
  response.issues.push({
    path,
    message: error instanceof Error ? error.message.slice(0, 1_024) : 'Cursor scan failed.'
  })
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function isVerifiedReadTooLargeError(error: unknown): boolean {
  return error instanceof Error && error.message === 'file_too_large'
}

function cancellationFromContext(context: RequestContext): CursorSidecarScanCancellation {
  return {
    throwIfCancelled: () => {
      if (context.isStale() || context.signal?.aborted) {
        throw new Error('cursor_sidecar_scan_cancelled')
      }
    }
  }
}

function throwIfCancelled(context: RequestContext): void {
  cancellationFromContext(context).throwIfCancelled()
}
