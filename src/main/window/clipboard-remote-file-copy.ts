import { randomUUID } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { app } from 'electron'

import { getRuntimePathBasename } from '../../shared/cross-platform-path'
import { requireSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import {
  writeFileToClipboard,
  type ClipboardFileDeps,
  type ClipboardFileResult
} from './clipboard-file-copy'

type RemoteClipboardFileDeps = Omit<ClipboardFileDeps, 'resolveFilePath'>

const REMOTE_CLIPBOARD_FILE_TTL_MS = 60 * 60 * 1000
const REMOTE_CLIPBOARD_FILE_PREFIX = 'orca-clipboard-file-'
const WINDOWS_RESERVED_LOCAL_BASENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i
const LOCAL_FILENAME_REPLACEMENT_CHARS = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*'])

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

  const tempDir = join(
    app.getPath('temp'),
    `${REMOTE_CLIPBOARD_FILE_PREFIX}${Date.now()}-${randomUUID()}`
  )
  await mkdir(tempDir, { mode: 0o700 })
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
      scheduleRemoteClipboardFileCleanup(tempDir)
    }
    return result
  } finally {
    if (!keepTempFile) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

export async function cleanupExpiredRemoteClipboardFiles(nowMs = Date.now()): Promise<void> {
  const tempRoot = app.getPath('temp')
  let entries: Dirent[]
  try {
    entries = await readdir(tempRoot, { withFileTypes: true })
  } catch {
    return
  }

  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isDirectory() || !entry.name.startsWith(REMOTE_CLIPBOARD_FILE_PREFIX)) {
        return
      }
      const tempDir = join(tempRoot, entry.name)
      try {
        const tempStats = await stat(tempDir)
        if (nowMs - tempStats.mtimeMs < REMOTE_CLIPBOARD_FILE_TTL_MS) {
          return
        }
        await rm(tempDir, { recursive: true, force: true })
      } catch {
        // Why: stale staged SSH files should not make startup cleanup noisy.
      }
    })
  )
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

function scheduleRemoteClipboardFileCleanup(tempDir: string): void {
  const timer = setTimeout(() => {
    void rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  }, REMOTE_CLIPBOARD_FILE_TTL_MS)
  if (typeof timer === 'object' && 'unref' in timer) {
    timer.unref()
  }
}
