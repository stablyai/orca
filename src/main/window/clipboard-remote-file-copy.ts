import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'

import { app } from 'electron'

import { getRuntimePathBasename } from '../../shared/cross-platform-path'
import { startSpan } from '../observability/tracer'
import { requireSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import {
  writeFileToClipboard,
  type ClipboardFileDeps,
  type ClipboardFileResult
} from './clipboard-file-copy'
import {
  cleanupExpiredRemoteClipboardStaging,
  cleanupLegacyRemoteClipboardStaging,
  createRemoteClipboardTransferDirectory,
  RemoteClipboardStagingRootUnsafeError,
  removeRemoteClipboardTransferDirectory,
  scheduleRemoteClipboardTransferCleanup
} from './clipboard-remote-file-staging'

type RemoteClipboardFileDeps = Omit<ClipboardFileDeps, 'resolveFilePath'>

const REMOTE_CLIPBOARD_LEGACY_CLEANUP_DELAY_MS = 30 * 1000
const WINDOWS_RESERVED_LOCAL_BASENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i
const LOCAL_FILENAME_REPLACEMENT_CHARS = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*'])
let legacyCleanupScheduled = false

export async function writeRemoteFileToClipboard({
  remotePath,
  connectionId,
  deps
}: {
  remotePath: string
  connectionId: string
  deps: RemoteClipboardFileDeps
}): Promise<ClipboardFileResult> {
  const provider = requireSshFilesystemProvider(connectionId)
  const remoteStat = await provider.stat(remotePath)
  if (remoteStat.type === 'directory') {
    return { ok: false, reason: 'is-directory' }
  }
  if (!provider.downloadFile) {
    throw new Error('Remote file download is unavailable. Reconnect the SSH target and retry.')
  }

  const tempRoot = app.getPath('temp')
  let tempDir: string
  try {
    tempDir = await createRemoteClipboardTransferDirectory(tempRoot, Date.now(), randomUUID())
  } catch (error) {
    const span = startSpan('clipboard.remote_staging_init', {
      attributes: {
        operation: 'create',
        platform: process.platform,
        failure_category: getStagingFailureCategory(error)
      }
    })
    span.fail(error instanceof Error ? error : String(error))
    return { ok: false, reason: 'staging-unavailable' }
  }
  const localPath = join(
    tempDir,
    sanitizeLocalClipboardFilename(getRuntimePathBasename(remotePath))
  )
  let keepTempFile = false

  try {
    await provider.downloadFile(remotePath, localPath)
    const result = await writeFileToClipboard(localPath, {
      ...deps,
      resolveFilePath: async (path) => {
        if (path !== localPath) {
          return { ok: false, reason: 'invalid-path' }
        }
        try {
          await stat(path)
          return { ok: true, path }
        } catch {
          return { ok: false, reason: 'not-found' }
        }
      }
    })
    if (result.ok) {
      // Why: OS file clipboards keep a path reference, so the staged copy must
      // survive after this IPC call long enough for the user to paste it.
      keepTempFile = true
      scheduleRemoteClipboardTransferCleanup(tempRoot, tempDir)
    }
    return result
  } finally {
    if (!keepTempFile) {
      await removeRemoteClipboardTransferDirectory(tempRoot, tempDir)
    }
  }
}

export async function cleanupExpiredRemoteClipboardFiles(nowMs = Date.now()): Promise<void> {
  await cleanupExpiredRemoteClipboardStaging(app.getPath('temp'), nowMs)
}

export async function cleanupLegacyRemoteClipboardFiles(nowMs = Date.now()): Promise<void> {
  await cleanupLegacyRemoteClipboardStaging(app.getPath('temp'), nowMs)
}

export function scheduleLegacyRemoteClipboardFileCleanup(): void {
  if (legacyCleanupScheduled) {
    return
  }
  legacyCleanupScheduled = true
  const timer = setTimeout(() => {
    void cleanupLegacyRemoteClipboardFiles().catch(() => undefined)
  }, REMOTE_CLIPBOARD_LEGACY_CLEANUP_DELAY_MS)
  unrefTimer(timer)
}

function sanitizeLocalClipboardFilename(remoteBasename: string): string {
  const sanitized = Array.from(remoteBasename, (char) =>
    char.charCodeAt(0) < 32 || LOCAL_FILENAME_REPLACEMENT_CHARS.has(char) ? '_' : char
  )
    .join('')
    .replace(/[. ]+$/g, '')
  if (!sanitized || WINDOWS_RESERVED_LOCAL_BASENAME.test(sanitized)) {
    return 'download'
  }
  return sanitized
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === 'object' && 'unref' in timer) {
    timer.unref()
  }
}

function getStagingFailureCategory(error: unknown): string {
  if (error instanceof RemoteClipboardStagingRootUnsafeError) {
    return 'unsafe-root'
  }
  const code = error instanceof Error && 'code' in error ? String(error.code) : undefined
  if (code === 'EACCES' || code === 'EPERM') {
    return 'permissions'
  }
  if (code === 'EEXIST' || code === 'ENOTDIR') {
    return 'path-conflict'
  }
  return 'unavailable'
}
