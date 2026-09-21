// @ts-nocheck -- mechanically split declarations.
import type { FileReadLimits, IFilesystemProvider } from '../providers/types'
import type { RuntimeFilePreviewResult } from '../../shared/runtime-types'
import { FileReadCapExceededError } from '../ssh/ssh-filesystem-stream-reader'
import {
  REMOTE_RPC_MAX_CONTENT_BYTES,
  remoteRpcResultExceedsContentBudget
} from '../../shared/remote-rpc-content-budget'
import { constants } from 'node:fs/promises'
import { getSshTargetIdForExecutionHost, type ExecutionHostId } from '../../shared/execution-host'
import { assertSshMutationExpectation } from '../ssh/ssh-connection-generation'
import { basenameFromRelativePath } from './runtime-file-paths'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'

export const MOBILE_FILE_LIST_LIMIT = 5000

export const QUICK_OPEN_LEGACY_REMOTE_RESULT_LIMIT = 32

export const MOBILE_FILE_PATH_SEARCH_CACHE_LIMIT = 20_000

export const MOBILE_FILE_PATH_SEARCH_CACHE_ENTRIES = 8

export const MOBILE_FILE_PATH_SEARCH_CACHE_TTL_MS = 30_000

export const MOBILE_FILE_READ_MAX_BYTES = 512 * 1024

export const LOCAL_PREVIEWABLE_BINARY_MAX_BYTES = 10 * 1024 * 1024

export const PREVIEWABLE_BINARY_EMPTY_RESULT_BYTES = Buffer.byteLength(
  JSON.stringify({
    content: '',
    isBinary: true,
    isImage: true,
    mimeType: 'application/octet-stream'
  }),
  'utf8'
)

export const PREVIEW_CONTENT_FIELDS = ['content'] as const

export function previewableBinaryByteLimit(maxContentBytes: number): number {
  const base64Bytes = Math.max(0, maxContentBytes - PREVIEWABLE_BINARY_EMPTY_RESULT_BYTES)
  return Math.floor(base64Bytes / 4) * 3
}

export async function readPreviewFileWithinCap(
  provider: IFilesystemProvider,
  filePath: string,
  limits: FileReadLimits
): Promise<RuntimeFilePreviewResult> {
  try {
    return await provider.readFile(filePath, limits)
  } catch (error) {
    if (error instanceof FileReadCapExceededError) {
      throw new Error('file_too_large')
    }
    throw error
  }
}

export function assertPreviewWithinTransportBudget(
  result: RuntimeFilePreviewResult,
  maxContentBytes: number | undefined
): RuntimeFilePreviewResult {
  if (
    maxContentBytes !== undefined &&
    remoteRpcResultExceedsContentBudget(result, maxContentBytes, PREVIEW_CONTENT_FIELDS)
  ) {
    throw new Error('file_too_large')
  }
  return result
}

export const RUNTIME_PREVIEWABLE_BINARY_MAX_BYTES = previewableBinaryByteLimit(
  REMOTE_RPC_MAX_CONTENT_BYTES
)

export const WINDOWS_RUNTIME_FILE_WATCH_DEBOUNCE_MS = 150

export const WINDOWS_RUNTIME_FILE_WATCH_CLOSE_DEADLINE_MS = 10_000

export const TERMINAL_FILE_GRANT_TTL_MS = 10 * 60 * 1000

export const OPEN_NOFOLLOW = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0

export const RUNTIME_FILE_MUTATION_UPDATE_REQUIRED =
  'Remote file changes require a newer Orca client. Update the paired client and try again.'

export function assertRuntimeFileMutationExpectation(
  // The resolved host, not a repo row's connection: recomputing it from `connectionId` here spelled
  // `runtime:<env>` and "unresolved" as `local`, so a client's host expectation could pass against
  // a host it never named (#11163).
  executionHostId: ExecutionHostId,
  expectedExecutionHostId: string | undefined,
  expectedSshTargetId: string | undefined,
  expectedSshConnectionGeneration: number | undefined
): void {
  if (!expectedExecutionHostId) {
    throw new Error(RUNTIME_FILE_MUTATION_UPDATE_REQUIRED)
  }
  if (expectedExecutionHostId !== executionHostId) {
    throw new Error('Workspace host changed; refresh and try again')
  }
  assertSshMutationExpectation(
    getSshTargetIdForExecutionHost(executionHostId) ?? undefined,
    expectedSshTargetId,
    expectedSshConnectionGeneration
  )
}

export const pendingRuntimeFileWatcherUnsubscribes = new Set<Promise<void>>()

export type RuntimeFileWatcherLease = {
  suspend(): Promise<void>
  resume(): Promise<void>
  forget(): void
}

export const runtimeFileWatcherLeasesByOwnerAndRoot = new Map<
  string,
  Set<RuntimeFileWatcherLease>
>()

export const sshFileExplorerWatchRearms = new Map<string, Set<() => void>>()

export const MOBILE_BINARY_EXTENSIONS = new Set([
  '.avif',
  '.bmp',
  '.gif',
  '.heic',
  '.ico',
  '.jpeg',
  '.jpg',
  '.mov',
  '.mp3',
  '.mp4',
  '.pdf',
  '.png',
  '.webp',
  '.zip'
])

export const MOBILE_PREVIEWABLE_IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.ico'
])

export type RuntimeFileStatLike = {
  size?: number
  dev?: number
  ino?: number
  nlink?: number
  mtime?: number | Date
  mtimeMs?: number
  isDirectory?: () => boolean
}

export type TerminalFileGrant = {
  id: string
  worktreeId: string
  absolutePath: string
  provider: 'local' | 'ssh'
  connectionId?: string
  clientId?: string
  expiresAt: number
  statIdentity: string | null
  readOnly: boolean
  provenance: 'terminal-output' | 'native-chat'
  expiryTimer?: ReturnType<typeof setTimeout>
}

export function isMobilePreviewableImagePath(relativePath: string): boolean {
  const basename = basenameFromRelativePath(relativePath)
  const dotIndex = basename.lastIndexOf('.')
  if (dotIndex <= 0) {
    return false
  }
  return MOBILE_PREVIEWABLE_IMAGE_EXTENSIONS.has(basename.slice(dotIndex).toLowerCase())
}

export const RUNTIME_PREVIEWABLE_BINARY_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf'
}

export function trackRuntimeFileWatcherUnsubscribe(
  rootPath: string,
  unsubscribe: () => Promise<void>
): Promise<void> {
  const promise = Promise.resolve()
    .then(unsubscribe)
    .finally(() => {
      pendingRuntimeFileWatcherUnsubscribes.delete(promise)
    })
  pendingRuntimeFileWatcherUnsubscribes.add(promise)
  void promise.catch((err: unknown) => {
    console.error('[runtime-files.watch] unsubscribe error', { rootPath, err })
  })
  return promise
}

export function normalizeRuntimeWatcherRoot(rootPath: string): string {
  return normalizeRuntimePathForComparison(rootPath)
}

export function runtimeWatcherReleaseKey(
  runtimeId: string,
  connectionId: string | undefined,
  rootPath: string
): string {
  // Why: identical absolute paths exist on local and multiple SSH hosts; scope teardown to the host that owns it.
  return JSON.stringify([runtimeId, connectionId ?? null, normalizeRuntimeWatcherRoot(rootPath)])
}
