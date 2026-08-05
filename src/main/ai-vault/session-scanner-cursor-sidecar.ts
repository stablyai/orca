import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import { readVerifiedBoundedTextFile } from '../../shared/node-verified-bounded-text-file'
import {
  CURSOR_SIDECAR_MAX_BYTES,
  cursorBucketForCwd,
  cursorSidecarBucket,
  cursorSidecarSessionId,
  isAbsoluteCursorTargetPath,
  resolveCursorTargetPath
} from './session-scanner-cursor-paths'
import type { CursorCwdEvidence, FileWithMtime } from './session-scanner-types'

export type CursorSidecarEvidence = {
  sessionId: string
  title: string
  createdAt: string
  updatedAt: string
  hasConversation: boolean
  isSubagent: boolean
  file: FileWithMtime
  cwdEvidence: CursorCwdEvidence | null
}

export type CursorSidecarParseResult = {
  evidence: CursorSidecarEvidence | null
  issue: AiVaultScanIssue | null
}

const SIDECAR_CACHE_MAX_ENTRIES = 4096
const sidecarCache = new Map<
  string,
  {
    mtimeMs: number
    sizeBytes: number | null
    storeMtimeMs: number | null
    dev: number | null
    ino: number | null
    nlink: number | null
    platform: NodeJS.Platform
    executionHostId: ExecutionHostId | null
    expectedRootRealPath: string | null
    result: CursorSidecarParseResult
  }
>()

export async function parseCursorSidecarFile(args: {
  file: FileWithMtime
  platform: NodeJS.Platform
  executionHostId?: ExecutionHostId
  expectedRootRealPath?: string
}): Promise<CursorSidecarParseResult> {
  if (!args.expectedRootRealPath) {
    throw new Error('cursor_sidecar_root_unavailable')
  }
  return parseCursorSidecarContent({
    ...args,
    content: await readVerifiedBoundedTextFile(args.file.path, {
      expectedRootRealPath: args.expectedRootRealPath,
      maxBytes: CURSOR_SIDECAR_MAX_BYTES
    })
  })
}

export async function parseCursorSidecarFileCached(args: {
  file: FileWithMtime
  platform: NodeJS.Platform
  executionHostId?: ExecutionHostId
  expectedRootRealPath?: string
}): Promise<CursorSidecarParseResult> {
  const cached = sidecarCache.get(args.file.path)
  if (
    cached &&
    cached.mtimeMs === args.file.mtimeMs &&
    cached.storeMtimeMs === (args.file.cursorStoreMtimeMs ?? null) &&
    cached.dev === (args.file.dev ?? null) &&
    cached.ino === (args.file.ino ?? null) &&
    cached.nlink === (args.file.nlink ?? null) &&
    cached.platform === args.platform &&
    cached.executionHostId === (args.executionHostId ?? null) &&
    cached.expectedRootRealPath === (args.expectedRootRealPath ?? null) &&
    (cached.sizeBytes === null ||
      args.file.sizeBytes === undefined ||
      cached.sizeBytes === args.file.sizeBytes)
  ) {
    sidecarCache.delete(args.file.path)
    sidecarCache.set(args.file.path, cached)
    return cached.result
  }
  const result = await parseCursorSidecarFile(args)
  sidecarCache.delete(args.file.path)
  sidecarCache.set(args.file.path, {
    mtimeMs: args.file.mtimeMs,
    sizeBytes: args.file.sizeBytes ?? null,
    storeMtimeMs: args.file.cursorStoreMtimeMs ?? null,
    dev: args.file.dev ?? null,
    ino: args.file.ino ?? null,
    nlink: args.file.nlink ?? null,
    platform: args.platform,
    executionHostId: args.executionHostId ?? null,
    expectedRootRealPath: args.expectedRootRealPath ?? null,
    result
  })
  if (sidecarCache.size > SIDECAR_CACHE_MAX_ENTRIES) {
    const oldest = sidecarCache.keys().next()
    if (!oldest.done) {
      sidecarCache.delete(oldest.value)
    }
  }
  return result
}

export function resetCursorSidecarParseCacheForTests(): void {
  sidecarCache.clear()
}

export function parseCursorSidecarContent(args: {
  file: FileWithMtime
  content: string
  platform: NodeJS.Platform
  executionHostId?: ExecutionHostId
}): CursorSidecarParseResult {
  let value: unknown
  try {
    value = JSON.parse(args.content) as unknown
  } catch {
    return {
      evidence: null,
      issue: issue(args, 'Malformed Cursor session metadata.')
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { evidence: null, issue: null }
  }
  const record = value as Record<string, unknown>
  if (typeof record.createdAtMs !== 'number' || !Number.isFinite(record.createdAtMs)) {
    return { evidence: null, issue: null }
  }
  const sessionId = cursorSidecarSessionId(args.file.path, args.platform)
  const bucket = cursorSidecarBucket(args.file.path, args.platform)
  if (!sessionId || !bucket) {
    return { evidence: null, issue: null }
  }

  const createdAtMs = representableDateMs(record.createdAtMs)
  if (createdAtMs === null) {
    return { evidence: null, issue: null }
  }
  const parsedUpdatedAtMs = representableDateMs(record.updatedAtMs)
  const storeMtimeMs = representableDateMs(args.file.cursorStoreMtimeMs)
  const updatedAtMs =
    parsedUpdatedAtMs !== null && parsedUpdatedAtMs > 0
      ? parsedUpdatedAtMs
      : storeMtimeMs !== null && storeMtimeMs > 0
        ? storeMtimeMs
        : null
  if (updatedAtMs === null) {
    return { evidence: null, issue: null }
  }
  const rawTitle = typeof record.title === 'string' ? record.title.trim() : ''
  const cwdResult = validatedSidecarCwd(record.cwd, args.platform, bucket)

  return {
    evidence: {
      sessionId,
      title: rawTitle || `Cursor ${sessionId.slice(0, 8)}`,
      createdAt: new Date(createdAtMs).toISOString(),
      updatedAt: new Date(updatedAtMs).toISOString(),
      hasConversation: record.hasConversation === true,
      isSubagent: record.isSubagent === true,
      file: args.file,
      cwdEvidence: cwdResult.cwd ? { kind: 'sidecar-bucket-match', cwd: cwdResult.cwd } : null
    },
    issue: cwdResult.mismatched
      ? issue(args, 'Cursor session cwd does not match its storage bucket.')
      : null
  }
}

function representableDateMs(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null
  }
  const floored = Math.floor(value)
  return Math.abs(floored) <= 8_640_000_000_000_000 ? floored : null
}

function validatedSidecarCwd(
  value: unknown,
  platform: NodeJS.Platform,
  bucket: string
): { cwd: string | null; mismatched: boolean } {
  if (typeof value !== 'string' || !value.trim()) {
    return { cwd: null, mismatched: false }
  }
  const cwd = value.trim()
  if (!isAbsoluteCursorTargetPath(cwd, platform)) {
    return { cwd: null, mismatched: false }
  }
  const resolved = resolveCursorTargetPath(cwd, platform)
  return cursorBucketForCwd(resolved, platform) === bucket
    ? { cwd: resolved, mismatched: false }
    : { cwd: null, mismatched: true }
}

function issue(
  args: {
    file: FileWithMtime
    executionHostId?: ExecutionHostId
  },
  message: string
): AiVaultScanIssue {
  return {
    ...(args.executionHostId ? { executionHostId: args.executionHostId } : {}),
    agent: 'cursor',
    path: args.file.path,
    message
  }
}
